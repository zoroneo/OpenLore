import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  VectorIndex,
  TOKENIZER_VERSION,
  _resetVectorIndexCachesForTesting,
} from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// Coverage for `persist-tokenized-keyword-corpus`: the BM25 corpus is persisted to
// a stamped sidecar, hydrated on cold start instead of re-tokenizing, and
// rebuilt-not-served on tokenizer skew / corruption. An incremental patch drops it.

function node(id: string, name: string, filePath: string): FunctionNode {
  return { id, name, filePath, language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 };
}

const NODES: FunctionNode[] = [
  node('src/users.ts::getUserById', 'getUserById', 'src/users.ts'),
  node('src/db.ts::connectDatabase', 'connectDatabase', 'src/db.ts'),
];
const SIGS: FileSignatureMap[] = [];
const MARKER = 'zzuniquemarkerzz'; // a token that appears in no node's raw text

describe('BM25 corpus persistence', () => {
  let tmpDir: string;
  let sidecar: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-bm25-persist-'));
    sidecar = join(tmpDir, 'vector-index', 'bm25-corpus.json');
    _resetVectorIndexCachesForTesting();
  });

  /** Inject `MARKER` into the persisted corpus for `getUserById`, so a query for it
   * hits ONLY if the sidecar (not a raw-text rebuild) was consulted. Keeps N and
   * doc ids intact so the integrity cross-check passes. */
  async function injectMarkerIntoSidecar(tokenizerVersion = TOKENIZER_VERSION): Promise<void> {
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    p.tokenizerVersion = tokenizerVersion;
    const doc = p.docs.find((d: { id: string }) => d.id === 'src/users.ts::getUserById');
    doc.tf.push([MARKER, 1]);
    doc.length += 1;
    p.df.push([MARKER, 1]);
    await writeFile(sidecar, JSON.stringify(p), 'utf-8');
  }

  it('build() writes a stamped corpus sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(true);
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(p.schemaVersion).toBe(1);
    expect(p.docs).toHaveLength(NODES.length);
  });

  it('a cold-start query hydrates from the sidecar (does not re-tokenize)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await injectMarkerIntoSidecar();
    _resetVectorIndexCachesForTesting();

    // MARKER is only in the sidecar, never in raw text — a hit proves hydration.
    const results = await VectorIndex.search(tmpDir, MARKER, null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('a tokenizer-version mismatch rebuilds and never serves the stale sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await injectMarkerIntoSidecar(TOKENIZER_VERSION - 1); // stamp it stale
    _resetVectorIndexCachesForTesting();

    // Stale sidecar ignored → MARKER (sidecar-only) must NOT match…
    const marker = await VectorIndex.search(tmpDir, MARKER, null, { limit: 10 });
    expect(marker.length).toBe(0);
    // …but a real query still works (rebuilt from raw text)…
    const real = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(real.some((r) => r.record.name === 'getUserById')).toBe(true);
    // …and the sidecar is re-stamped to the current version (marker dropped).
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
    expect(JSON.stringify(p).includes(MARKER)).toBe(false);
  });

  it('a missing sidecar degrades to a raw-text rebuild (and re-persists)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await rm(sidecar);
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
    expect(existsSync(sidecar)).toBe(true); // re-persisted for the next process
  });

  it('a corrupt sidecar degrades without throwing (and re-persists)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    await writeFile(sidecar, 'not json {{{', 'utf-8');
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
    const p = JSON.parse(await readFile(sidecar, 'utf-8')); // valid again
    expect(p.tokenizerVersion).toBe(TOKENIZER_VERSION);
  });

  it('an incremental update invalidates the sidecar', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(true);
    _resetVectorIndexCachesForTesting();

    await VectorIndex.updateFiles(tmpDir, NODES, new Set(['src/users.ts']), SIGS, new Set(), new Set(), null);
    expect(existsSync(sidecar)).toBe(false); // dropped so next cold start rebuilds
  });

  it('a defensive doc-count mismatch is ignored in favour of a rebuild', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    const p = JSON.parse(await readFile(sidecar, 'utf-8'));
    p.N = 999; // lie about the corpus size
    await writeFile(sidecar, JSON.stringify(p), 'utf-8');
    _resetVectorIndexCachesForTesting();

    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('hydrated results equal a fresh rebuild for the same query', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    const hydrated = await VectorIndex.search(tmpDir, 'connect', null, { limit: 10 });

    await rm(sidecar); // force the rebuild path
    _resetVectorIndexCachesForTesting();
    const rebuilt = await VectorIndex.search(tmpDir, 'connect', null, { limit: 10 });

    expect(hydrated.map((r) => r.record.id)).toEqual(rebuilt.map((r) => r.record.id));
    expect(hydrated.map((r) => r.score)).toEqual(rebuilt.map((r) => r.score));
  });
});

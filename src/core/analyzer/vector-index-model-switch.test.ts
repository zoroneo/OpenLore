import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VectorIndex, _resetVectorIndexCachesForTesting } from './vector-index.js';
import type { Embedder } from './embedding-service.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// Regression coverage for the model/dimension-switch hazard
// (PR #191 adversarial review, finding HIGH-1): switching the embedding model must
// never reuse stale-dimension cached vectors or crash a query against a stale index.

const NODES: FunctionNode[] = [
  { id: 'src/a.ts::alpha', name: 'alpha', filePath: 'src/a.ts', language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 },
  { id: 'src/b.ts::beta', name: 'beta', filePath: 'src/b.ts', language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: 10, fanIn: 2, fanOut: 1 },
];
const SIGS: FileSignatureMap[] = [];

/** A deterministic fake embedder with a declared modelName and fixed dimension. */
function fakeEmbedder(modelName: string, dim: number): Embedder {
  return {
    modelName,
    embed: async (texts: string[]) =>
      texts.map((_, i) => Array.from({ length: dim }, (_, j) => ((i + j + 1) % 7) * 0.1)),
  };
}

describe('VectorIndex — embedding model/dimension switch safety', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-model-switch-'));
    _resetVectorIndexCachesForTesting();
  });

  async function readMetaDim(): Promise<number> {
    const raw = await readFile(join(tmpDir, 'vector-index-meta.json'), 'utf-8');
    return JSON.parse(raw).dim as number;
  }

  it('a model switch on incremental rebuild re-embeds everything (no stale-dimension reuse)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-a', 4));
    expect(await readMetaDim()).toBe(4);
    _resetVectorIndexCachesForTesting();

    // Incremental rebuild with a DIFFERENT model + dimension. Without the model-match
    // gate this would reuse the 4-dim vectors and produce a mixed-dimension table.
    const res = await VectorIndex.build(
      tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-b', 8), undefined, /* incremental */ true
    );
    expect(res.reused).toBe(0);
    expect(res.embedded).toBe(res.total);
    expect(await readMetaDim()).toBe(8);
  });

  it('the same model still reuses cached vectors on incremental rebuild', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-a', 4));
    _resetVectorIndexCachesForTesting();
    const res = await VectorIndex.build(
      tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-a', 4), undefined, /* incremental */ true
    );
    expect(res.reused).toBe(res.total);
    expect(res.embedded).toBe(0);
  });

  it('search degrades to BM25 (no crash) when the query embedder dimension disagrees with the index', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-a', 4));
    _resetVectorIndexCachesForTesting();
    // Query with a wrong-dimension embedder — the dim guard must fall back to BM25
    // rather than letting LanceDB throw on a dimension mismatch.
    const results = await VectorIndex.search(tmpDir, 'alpha', fakeEmbedder('model-b', 8), { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThan(0);
  });

  it('updateFiles refuses to mix dimensions when the model changed (leaves index consistent)', async () => {
    await VectorIndex.build(tmpDir, NODES, SIGS, new Set(), new Set(), fakeEmbedder('model-a', 4));
    expect(await readMetaDim()).toBe(4);
    _resetVectorIndexCachesForTesting();

    const res = await VectorIndex.updateFiles(
      tmpDir, NODES, new Set(['src/a.ts']), SIGS, new Set(), new Set(), fakeEmbedder('model-b', 8)
    );
    // Refused: no rows added under the new model, index stays 4-dim and queryable.
    expect(res.embedded).toBe(0);
    expect(await readMetaDim()).toBe(4);
    const results = await VectorIndex.search(tmpDir, 'alpha', fakeEmbedder('model-a', 4), { limit: 5 });
    expect(Array.isArray(results)).toBe(true);
  });
});

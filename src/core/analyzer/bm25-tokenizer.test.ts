import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  tokenize,
  buildBm25Corpus,
  bm25Score,
  TOKENIZER_VERSION,
  VectorIndex,
  _resetVectorIndexCachesForTesting,
} from './vector-index.js';
import type { FunctionNode } from './call-graph.js';
import type { FileSignatureMap } from './signature-extractor.js';

// Coverage for `fix-bm25-identifier-tokenization`: the keyword (BM25) tokenizer
// splits compound identifiers into sub-tokens AND retains the compound, applied
// identically at index and query time, with a tokenizer-version stamp so a skewed
// index rebuilds rather than serving mixed-token results.

describe('tokenize — identifier-aware BM25 tokenization', () => {
  it('splits camelCase into sub-tokens and retains the compound', () => {
    const t = tokenize('getUserById');
    expect(t).toContain('getuserbyid'); // compound retained
    expect(t).toEqual(expect.arrayContaining(['get', 'user', 'by', 'id']));
  });

  it('splits PascalCase and acronym runs', () => {
    const t = tokenize('parseHTMLResponse');
    expect(t).toContain('parsehtmlresponse');
    expect(t).toEqual(expect.arrayContaining(['parse', 'html', 'response']));
  });

  it('drops sub-tokens of 1 char but keeps the compound (unchanged >1-char filter)', () => {
    // `id` is 2 chars (kept); a lone letter boundary would be dropped.
    const t = tokenize('aB'); // → compound "ab"; subs "a","b" both dropped
    expect(t).toEqual(['ab']);
  });

  it('is a pure lexical split — a single lowercase word is unchanged', () => {
    expect(tokenize('user')).toEqual(['user']);
    expect(tokenize('authenticate')).toEqual(['authenticate']);
  });

  describe('a sub-word query finds a compound identifier', () => {
    const corpus = buildBm25Corpus([
      { id: 'a', text: 'getUserById' },
      { id: 'b', text: 'connectDatabase' },
    ]);
    it('`user` matches getUserById', () => {
      const score = bm25Score(corpus, tokenize('user'), 0);
      expect(score).toBeGreaterThan(0);
    });
    it('`getUser` matches getUserById', () => {
      const score = bm25Score(corpus, tokenize('getUser'), 0);
      expect(score).toBeGreaterThan(0);
    });
    it('`user` does NOT match an unrelated identifier', () => {
      const score = bm25Score(corpus, tokenize('user'), 1);
      expect(score).toBe(0);
    });
  });

  it('naming conventions produce the same sub-token set', () => {
    // Each convention yields the same {get,user,by,id} sub-tokens, so a sub-word
    // query matches all three equivalently (the compound token differs only when
    // the source was itself a single compound identifier).
    const forms = ['getUserById', 'get_user_by_id', 'get-user-by-id', 'GetUserById'];
    for (const form of forms) {
      const toks = new Set(tokenize(form));
      for (const sub of ['get', 'user', 'by', 'id']) {
        expect(toks.has(sub)).toBe(true);
      }
    }
  });

  it('the exact compound query ranks the exact match first', () => {
    // A corpus where several docs share sub-tokens but only one is the exact compound.
    const corpus = buildBm25Corpus([
      { id: 'exact', text: 'getUserById' },
      { id: 'shares-get-user', text: 'getUser getUserProfile' },
      { id: 'shares-by-id', text: 'findById byIdLookup' },
    ]);
    const q = tokenize('getUserById');
    const ranked = corpus.docs
      .map((_, i) => ({ id: corpus.docs[i].id, score: bm25Score(corpus, q, i) }))
      .sort((a, b) => b.score - a.score);
    expect(ranked[0].id).toBe('exact');
  });

  it('exports a tokenizer version stamp', () => {
    expect(TOKENIZER_VERSION).toBe(2);
  });
});

// ── End-to-end: the headline scenario over a real BM25-only index ─────────────

function node(id: string, name: string, filePath: string): FunctionNode {
  return { id, name, filePath, language: 'TypeScript', isAsync: false, startIndex: 0, endIndex: 10, fanIn: 1, fanOut: 0 };
}

const E2E_NODES: FunctionNode[] = [
  node('src/users.ts::getUserById', 'getUserById', 'src/users.ts'),
  node('src/db.ts::connectDatabase', 'connectDatabase', 'src/db.ts'),
];
const E2E_SIGS: FileSignatureMap[] = [];

describe('BM25-only search — sub-word queries find compound identifiers', () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'openlore-bm25-tok-'));
    _resetVectorIndexCachesForTesting();
  });

  it('`user` finds getUserById (keyword mode, no embedder)', async () => {
    await VectorIndex.build(tmpDir, E2E_NODES, E2E_SIGS, new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('the meta sidecar stamps the tokenizer version', async () => {
    await VectorIndex.build(tmpDir, E2E_NODES, E2E_SIGS, new Set(), new Set(), null);
    const raw = await readFile(join(tmpDir, 'vector-index-meta.json'), 'utf-8');
    expect(JSON.parse(raw).tokenizerVersion).toBe(TOKENIZER_VERSION);
  });

  it('updateFiles defers when the on-disk tokenizer version is stale (skew rebuild, never mix)', async () => {
    await VectorIndex.build(tmpDir, E2E_NODES, E2E_SIGS, new Set(), new Set(), null);
    // Simulate an index built under a previous tokenizer: rewrite the stamp to v1.
    const metaPath = join(tmpDir, 'vector-index-meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    meta.tokenizerVersion = 1;
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    _resetVectorIndexCachesForTesting();

    const res = await VectorIndex.updateFiles(
      tmpDir, E2E_NODES, new Set(['src/users.ts']), E2E_SIGS, new Set(), new Set(), null,
    );
    // Refused: no incremental patch under the new tokenizer against a v1 corpus.
    expect(res.deferred).toBe('tokenizer-changed');
    expect(res.embedded).toBe(0);
    // Search still serves correct results (corpus re-tokenized from raw text).
    const results = await VectorIndex.search(tmpDir, 'user', null, { limit: 10 });
    expect(results.some((r) => r.record.name === 'getUserById')).toBe(true);
  });

  it('a legacy meta without the stamp is treated as v1 and defers', async () => {
    await VectorIndex.build(tmpDir, E2E_NODES, E2E_SIGS, new Set(), new Set(), null);
    const metaPath = join(tmpDir, 'vector-index-meta.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf-8'));
    delete meta.tokenizerVersion;
    await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf-8');
    _resetVectorIndexCachesForTesting();

    const res = await VectorIndex.updateFiles(
      tmpDir, E2E_NODES, new Set(['src/users.ts']), E2E_SIGS, new Set(), new Set(), null,
    );
    expect(res.deferred).toBe('tokenizer-changed');
  });

  it('a same-version index still updates incrementally (no false defer)', async () => {
    await VectorIndex.build(tmpDir, E2E_NODES, E2E_SIGS, new Set(), new Set(), null);
    _resetVectorIndexCachesForTesting();
    const res = await VectorIndex.updateFiles(
      tmpDir, E2E_NODES, new Set(['src/users.ts']), E2E_SIGS, new Set(), new Set(), null,
    );
    expect(res.deferred).toBeUndefined();
  });
});

/**
 * remember / recall handlers — end-to-end over a real edge store + source files.
 * (change: add-code-anchored-memory-staleness)
 *
 * Guards the mcp-handlers-spec requirements AnchoredMemoryWriteAndRecall and
 * NoSilentStaleMemory: an orphaned memory is never returned as authoritative.
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
import { handleRemember, handleRecall } from './memory.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

let root: string;

const FOO_SRC = 'export function foo() {\n  return 1;\n}\n';

function fooNode(filePath: string, src: string): FunctionNode {
  return {
    id: `${filePath}::foo`,
    name: 'foo',
    filePath,
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: Buffer.byteLength(src, 'utf-8'),
    fanIn: 0,
    fanOut: 0,
  };
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-mem-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.ts'), FOO_SRC, 'utf-8');
  await buildStore([fooNode('src/foo.ts', FOO_SRC)]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('handleRemember', () => {
  it('resolves a symbol hint to a symbol-level anchor', async () => {
    const r = (await handleRemember(root, 'foo must stay pure', [{ symbol: 'foo', file: 'src/foo.ts' }])) as {
      anchored: boolean; anchors: Array<{ level: string; symbol?: string }>;
    };
    expect(r.anchored).toBe(true);
    expect(r.anchors[0]).toMatchObject({ level: 'symbol', symbol: 'foo' });
  });

  it('records an unanchored memory when no analysis can resolve the hint', async () => {
    const r = (await handleRemember(root, 'a free-floating note')) as { anchored: boolean };
    expect(r.anchored).toBe(false);
  });
});

describe('handleRecall — bullet-proof guarantee', () => {
  it('returns a fresh memory as authoritative', async () => {
    await handleRemember(root, 'foo must stay pure', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    const r = (await handleRecall(root, 'foo')) as {
      authoritative: Array<{ id: string; freshness: string }>; needsReanchoring: unknown[];
    };
    expect(r.authoritative).toHaveLength(1);
    expect(r.authoritative[0].freshness).toBe('fresh');
    expect(r.needsReanchoring).toHaveLength(0);
  });

  it('marks a memory drifted (verify) when the anchored code changes', async () => {
    await handleRemember(root, 'foo must stay pure', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    // Change the function body in place so its span hash differs.
    await writeFile(join(root, 'src', 'foo.ts'), 'export function foo() {\n  return 999;\n}\n', 'utf-8');
    const r = (await handleRecall(root, 'foo')) as {
      authoritative: Array<{ freshness: string; verify?: boolean }>;
    };
    expect(r.authoritative[0].freshness).toBe('drifted');
    expect(r.authoritative[0].verify).toBe(true);
  });

  it('NEVER serves an orphaned memory as authoritative', async () => {
    await handleRemember(root, 'foo must stay pure', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    // The anchored symbol disappears from the graph.
    await buildStore([]);
    const r = (await handleRecall(root, 'foo')) as {
      authoritative: Array<{ freshness: string }>;
      needsReanchoring: Array<{ id: string; freshness: string }>;
      summary: { orphaned: number };
    };
    expect(r.authoritative).toHaveLength(0);
    expect(r.needsReanchoring).toHaveLength(1);
    expect(r.needsReanchoring[0].freshness).toBe('orphaned');
    expect(r.summary.orphaned).toBe(1);
  });

  it('with no task, scans all memory for staleness', async () => {
    await handleRemember(root, 'first note', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    await handleRemember(root, 'second unrelated note');
    const r = (await handleRecall(root)) as { total: number };
    expect(r.total).toBe(2);
  });
});

// ── decisions in recall + adversarial inputs ──────────────────────────────────

interface PartialDecision {
  id: string; status: string; title: string; rationale?: string;
  affectedFiles?: string[]; affectedDomains?: string[];
  anchors?: Array<Record<string, unknown>>;
}
async function writeDecisions(decisions: PartialDecision[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  const full = decisions.map((d) => ({
    consequences: '', proposedRequirement: null, affectedDomains: [], affectedFiles: [],
    sessionId: 's', recordedAt: '2026-01-01T00:00:00Z', confidence: 'medium', syncedToSpecs: [],
    rationale: '', ...d,
  }));
  await writeFile(join(dir, 'pending.json'),
    JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }, null, 2), 'utf-8');
}

describe('handleRecall — decisions', () => {
  it('includes an active decision with a fresh file anchor as authoritative', async () => {
    await writeDecisions([{ id: 'd1', status: 'approved', title: 'keep foo pure', affectedFiles: ['src/foo.ts'] }]);
    const r = (await handleRecall(root, 'foo pure')) as {
      authoritative: Array<{ kind: string; id: string; freshness: string }>;
    };
    const dec = r.authoritative.find((m) => m.kind === 'decision');
    expect(dec).toBeDefined();
    expect(dec!.freshness).toBe('fresh');
  });

  it('puts a decision whose only affected file was deleted into needsReanchoring (legacy file anchor)', async () => {
    await writeDecisions([{ id: 'd2', status: 'approved', title: 'about gone', affectedFiles: ['src/gone.ts'] }]);
    const r = (await handleRecall(root, 'gone')) as {
      authoritative: unknown[]; needsReanchoring: Array<{ id: string; freshness: string }>;
    };
    expect(r.needsReanchoring.some((m) => m.id === 'd2' && m.freshness === 'orphaned')).toBe(true);
    expect(r.authoritative).toHaveLength(0);
  });

  it('excludes inactive (rejected/synced/phantom) decisions', async () => {
    await writeDecisions([
      { id: 'r1', status: 'rejected', title: 'rejected foo', affectedFiles: ['src/foo.ts'] },
      { id: 's1', status: 'synced', title: 'synced foo', affectedFiles: ['src/foo.ts'] },
      { id: 'p1', status: 'phantom', title: 'phantom foo', affectedFiles: ['src/foo.ts'] },
    ]);
    const r = (await handleRecall(root, 'foo')) as { total: number; authoritative: unknown[]; needsReanchoring: unknown[] };
    expect(r.total).toBe(0);
  });
});

describe('handleRecall — retrieval semantics & robustness', () => {
  it('filters by task token overlap and honors limit', async () => {
    await handleRemember(root, 'alpha invariant about parsing');
    await handleRemember(root, 'beta note about networking');
    const r = (await handleRecall(root, 'parsing')) as { total: number; authoritative: Array<{ text: string }> };
    expect(r.total).toBe(1);
    expect(r.authoritative[0].text).toContain('parsing');

    const limited = (await handleRecall(root, undefined, 1)) as { total: number };
    expect(limited.total).toBe(1); // 2 memories exist, limit caps to 1
  });

  it('matches via tags', async () => {
    await handleRemember(root, 'a note', undefined, ['concurrency']);
    const r = (await handleRecall(root, 'concurrency')) as { total: number };
    expect(r.total).toBe(1);
  });

  it('reports graphAvailable=false and withholds anchored memory when analysis is absent', async () => {
    await handleRemember(root, 'anchored note', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    // Remove the edge store so freshness cannot be verified.
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    const r = (await handleRecall(root, 'note')) as {
      graphAvailable: boolean; authoritative: unknown[]; needsReanchoring: unknown[];
    };
    expect(r.graphAvailable).toBe(false);
    // Unverifiable ⇒ never authoritative.
    expect(r.authoritative).toHaveLength(0);
    expect(r.needsReanchoring).toHaveLength(1);
  });

  it('survives a corrupted notes store without crashing', async () => {
    const dir = join(root, OPENLORE_DIR, 'memory');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'notes.json'), '{ this is not valid json', 'utf-8');
    const r = (await handleRecall(root, 'anything')) as { total: number; authoritative: unknown[] };
    expect(r.total).toBe(0); // no crash, empty store
  });

  it('rejects empty remember content', async () => {
    const r = (await handleRemember(root, '   ')) as { error?: string };
    expect(r.error).toBeDefined();
  });
});

// ── deterministic ranking (improve-recall-retrieval-ranking) ──────────────────

function namedNode(name: string, filePath: string, src: string): FunctionNode {
  return {
    id: `${filePath}::${name}`,
    name,
    filePath,
    isAsync: false,
    language: 'typescript',
    startIndex: 0,
    endIndex: Buffer.byteLength(src, 'utf-8'),
    fanIn: 0,
    fanOut: 0,
  };
}

describe('handleRecall — deterministic ranking', () => {
  it('closes a phrasing miss: identifier normalization surfaces a memory the old substring ranker dropped', async () => {
    // Old ranker: query "write" is NOT a substring of "writeThrough" tokenized to
    // "writethrough"? It IS (includes), but a query "caching" would miss entirely.
    // Here we prove camelCase normalization links "write" ↔ "writeThrough".
    await handleRemember(root, 'the cache is writeThrough', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    const r = (await handleRecall(root, 'write strategy')) as {
      total: number; authoritative: Array<{ text: string }>;
    };
    expect(r.total).toBe(1);
    expect(r.authoritative[0].text).toContain('writeThrough');
  });

  it('ranks a memory anchored to the named symbol above a prose-only mention', async () => {
    await writeFile(join(root, 'src', 'cfg.ts'), 'export function parseConfig() {\n  return {};\n}\n', 'utf-8');
    await buildStore([
      fooNode('src/foo.ts', FOO_SRC),
      namedNode('parseConfig', 'src/cfg.ts', 'export function parseConfig() {\n  return {};\n}\n'),
    ]);
    // M1 is *about* parseConfig (anchored to it). M2 only mentions it in prose.
    await handleRemember(root, 'tunables live here', [{ symbol: 'parseConfig', file: 'src/cfg.ts' }]);
    await handleRemember(root, 'remember to call parseConfig early', [{ symbol: 'foo', file: 'src/foo.ts' }]);
    const r = (await handleRecall(root, 'parseConfig')) as {
      authoritative: Array<{ text: string; match?: { anchorBoost: boolean } }>;
    };
    expect(r.authoritative).toHaveLength(2);
    expect(r.authoritative[0].text).toBe('tunables live here'); // anchored one ranks first
    expect(r.authoritative[0].match?.anchorBoost).toBe(true);
  });

  it('exposes a transparent ranking reason (matched fields) when a task is given', async () => {
    await handleRemember(root, 'a note about parsing', undefined, ['parser']);
    const r = (await handleRecall(root, 'parser')) as {
      authoritative: Array<{ match?: { fields: string[]; anchorBoost: boolean } }>;
    };
    expect(r.authoritative[0].match?.fields).toContain('tags');
  });

  it('a high-scoring orphaned memory is still excluded from authoritative (invariant holds before ranking matters)', async () => {
    await handleRemember(root, 'parseConfig parseConfig parseConfig is critical', [
      { symbol: 'parseConfig', file: 'src/cfg.ts' },
    ]);
    await buildStore([]); // symbol disappears ⇒ orphaned
    const r = (await handleRecall(root, 'parseConfig')) as {
      authoritative: unknown[]; needsReanchoring: Array<{ freshness: string }>;
    };
    expect(r.authoritative).toHaveLength(0);
    expect(r.needsReanchoring[0].freshness).toBe('orphaned');
  });
});

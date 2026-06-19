/**
 * orient ReversalAwareness (change: add-cross-agent-intent-handoff).
 *
 * Proves the do-not-repeat guarantee at the default entry tool: orient surfaces
 * reverted/superseded intent in scope as an explicit `reversals` warning, reading
 * the bitemporal supersession record (memories) and decision supersedes links —
 * rather than silently omitting reverted history. Reverted intent is never served
 * as authoritative current context.
 *
 * Only the vector-index modules are mocked (orthogonal to reversal surfacing). The
 * decision store, the memory store, and supersession all run for real against a
 * temp repo. Plain .test.ts so CI runs it. (The reverting-commit SHA in the warning
 * is covered by the e2e dogfood, which runs against a real git repo.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../analyzer/vector-index.js', () => ({
  VectorIndex: { exists: vi.fn(() => true), search: vi.fn(async () => []) },
}));
vi.mock('../../analyzer/embedding-service.js', () => ({
  EmbeddingService: { fromEnv: vi.fn(() => { throw new Error('no env'); }), fromConfig: vi.fn(() => null) },
}));
vi.mock('../../analyzer/spec-vector-index.js', () => ({
  SpecVectorIndex: { exists: vi.fn(() => false), search: vi.fn(async () => []) },
}));

import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_LLM_CONTEXT } from '../../../constants.js';
import { handleOrient } from './orient.js';
import { handleRemember } from './memory.js';
import type { FunctionNode } from '../../analyzer/call-graph.js';

let root: string;
const SRC = 'export function fooHandler() {\n  return 1;\n}\n';

interface ReversalOut {
  source: 'memory' | 'decision' | 'note';
  id: string;
  what: string;
  reason?: string;
  revertedAtCommit?: string;
  supersededBy?: string;
  warning: string;
}
type OrientOut = {
  error?: string;
  reversals?: ReversalOut[];
  pendingDecisions?: Array<{ id: string }>;
};

function node(filePath: string, name: string, startIndex: number, endIndex: number): FunctionNode {
  return { id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript', startIndex, endIndex, fanIn: 0, fanOut: 0 };
}

async function analysisDir(): Promise<string> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const store = EdgeStore.open(EdgeStore.dbPath(await analysisDir()));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

async function writeLlmContext(nodes: FunctionNode[]): Promise<void> {
  const callGraph = {
    nodes, edges: [], classes: [], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
  await writeFile(join(await analysisDir(), ARTIFACT_LLM_CONTEXT), JSON.stringify({ callGraph }), 'utf-8');
}

async function writeDecisions(decisions: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  const full = decisions.map((d) => ({
    status: 'approved', title: 'untitled', rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
    confidence: 'medium', syncedToSpecs: [], ...d,
  }));
  await writeFile(join(dir, 'pending.json'), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }), 'utf-8');
}

beforeEach(async () => {
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), 'openlore-orient-rev-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'foo.ts'), SRC, 'utf-8');
  const nodes = [node('src/foo.ts', 'fooHandler', 0, Buffer.byteLength(SRC, 'utf-8'))];
  await buildStore(nodes);
  await writeLlmContext(nodes);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('orient — ReversalAwareness (do-not-repeat)', () => {
  it('surfaces a decision superseded by another as a do-not-repeat warning, not as authoritative', async () => {
    // A (rejected) was the reverted approach; B (approved) supersedes it. B's presence
    // in scope (foo.ts) also brings the file into the task's scope.
    await writeDecisions([
      { id: 'oldA', status: 'rejected', title: 'cache fooHandler results in a module global',
        rationale: 'speed', affectedFiles: ['src/foo.ts'] },
      { id: 'newB', status: 'approved', supersedes: 'oldA', title: 'keep fooHandler pure',
        rationale: 'the module global caused cross-request races', affectedFiles: ['src/foo.ts'] },
    ]);
    const r = (await handleOrient(root, 'work on fooHandler')) as OrientOut;
    expect(r.error).toBeUndefined();
    const rev = r.reversals?.find((x) => x.id === 'oldA');
    expect(rev, 'reverted decision oldA is surfaced').toBeDefined();
    expect(rev!.source).toBe('decision');
    expect(rev!.supersededBy).toBe('newB');
    expect(rev!.reason).toContain('cross-request races');
    expect(rev!.warning).toContain('Do not re-attempt');
    expect(rev!.warning).toContain('cache fooHandler results');
    // The reverted decision must NEVER be served as authoritative current context.
    expect((r.pendingDecisions ?? []).map((d) => d.id)).not.toContain('oldA');
  });

  it('surfaces a superseded memory as do-not-repeat with the recorded reason', async () => {
    // An active decision brings src/foo.ts into scope (search is mocked empty here).
    await writeDecisions([{ id: 'd1', title: 'fooHandler is owned here', affectedFiles: ['src/foo.ts'] }]);
    const m = (await handleRemember(root, 'fooHandler memoizes via a global mutable cache',
      [{ symbol: 'fooHandler', file: 'src/foo.ts' }])) as { id: string };
    await handleRemember(root, 'fooHandler was made pure; the global cache caused races',
      [{ symbol: 'fooHandler', file: 'src/foo.ts' }], undefined, undefined, m.id);
    const r = (await handleOrient(root, 'work on fooHandler')) as OrientOut;
    const rev = r.reversals?.find((x) => x.source === 'memory' && x.id === m.id);
    expect(rev, 'superseded memory surfaced').toBeDefined();
    expect(rev!.what).toContain('global mutable cache');
    expect(rev!.reason).toContain('caused races');
    expect(rev!.warning).toContain('Do not re-attempt');
  });

  it('does NOT surface a reverted decision that is out of the task scope', async () => {
    // newB is in scope (foo.ts); oldOut was reverted but only touches an unrelated file.
    await writeDecisions([
      { id: 'oldOut', status: 'rejected', title: 'reverted thing about another module',
        rationale: 'x', affectedFiles: ['src/unrelated.ts'] },
      // synced (inactive) superseder — does not pull src/unrelated.ts into the task scope.
      { id: 'newOut', status: 'synced', supersedes: 'oldOut', title: 'replacement',
        rationale: 'y', affectedFiles: ['src/unrelated.ts'] },
      { id: 'inScope', status: 'approved', title: 'fooHandler stays here', affectedFiles: ['src/foo.ts'] },
    ]);
    const r = (await handleOrient(root, 'work on fooHandler')) as OrientOut;
    expect((r.reversals ?? []).map((x) => x.id)).not.toContain('oldOut');
  });

  it('omits the reversals field entirely when nothing in scope was reverted', async () => {
    await writeDecisions([{ id: 'active1', title: 'keep fooHandler pure', affectedFiles: ['src/foo.ts'] }]);
    await handleRemember(root, 'fooHandler returns a count', [{ symbol: 'fooHandler', file: 'src/foo.ts' }]);
    const r = (await handleOrient(root, 'work on fooHandler')) as OrientOut;
    expect(r.reversals).toBeUndefined();
  });
});

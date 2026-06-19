/**
 * Spec-19 — Deterministic Test Impact Selection.
 * Backward reachability over a known test→code fixture: paths, over-approximation
 * posture, coverage honesty, and the tested_by harvest path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (d: string) => d),
  readCachedContext: vi.fn(),
}));

vi.mock('../../drift/git-diff.js', () => ({
  getChangedFiles: vi.fn(async () => ({ files: [] })),
}));

import { handleSelectTests, seedsFromSymbols, seedsFromFiles } from './test-impact.js';
import { readCachedContext } from './utils.js';
import { getChangedFiles } from '../../drift/git-diff.js';
import type { FunctionNode, SerializedCallGraph, CallEdge } from '../../analyzer/call-graph.js';

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id,
    filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 100, fanIn: 0, fanOut: 0,
    ...over,
  };
}
function edge(callerId: string, calleeId: string, kind: CallEdge['kind'] = 'calls', calleeName?: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeName ?? calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return { nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 } };
}

// Fixture: foo.test.ts::testFoo → foo → bar ; bar is tested_by bar.test.ts::testBar
const NODES = [
  node({ id: 'src/foo.ts::foo', fanOut: 1, fanIn: 1 }),
  node({ id: 'src/foo.ts::bar', fanIn: 1 }),
  node({ id: 'src/foo.test.ts::testFoo', isTest: true, fanOut: 1 }),
  node({ id: 'src/bar.test.ts::testBar', isTest: true, fanOut: 1 }),
];
const EDGES = [
  edge('src/foo.test.ts::testFoo', 'src/foo.ts::foo'),
  edge('src/foo.ts::foo', 'src/foo.ts::bar'),
  // tested_by points production → test (as the analyzer emits it)
  edge('src/foo.ts::bar', 'src/bar.test.ts::testBar', 'tested_by', 'testBar'),
];

describe('handleSelectTests', () => {
  beforeEach(() => {
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, EDGES) } as never);
  });

  it('selects tests that transitively reach the changed symbol, with paths', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      selectedTests: Array<{ test: string; file: string; viaPath: string[]; confidence: string }>;
      soundness: { posture: string; caveats: string[] };
      coverage: { languages: string[]; testDetection: string };
    };
    const names = r.selectedTests.map(t => t.test).sort();
    expect(names).toEqual(['testBar', 'testFoo']);

    // testFoo reaches bar through foo: [testFoo, foo, bar]
    const viaFoo = r.selectedTests.find(t => t.test === 'testFoo')!;
    expect(viaFoo.viaPath).toEqual(['testFoo', 'foo', 'bar']);
    // testBar is attached directly to bar by a tested_by edge — high confidence
    const viaBar = r.selectedTests.find(t => t.test === 'testBar')!;
    expect(viaBar.confidence).toBe('high');

    expect(r.coverage).toEqual({ languages: ['typescript'], testDetection: 'full' });
    expect(r.soundness.posture).toBe('over-approximate');
    expect(r.soundness.caveats.join(' ')).toMatch(/dynamic dispatch/i);
  });

  it('an upstream change still selects only the tests that reach it', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['foo'] }) as { selectedTests: Array<{ test: string }> };
    // testFoo calls foo directly; testBar tests bar (downstream of foo) — not reaching foo.
    expect(r.selectedTests.map(t => t.test)).toEqual(['testFoo']);
  });

  it('reports testDetection "none" and a caveat when the graph has no tests', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce({
      callGraph: graph([node({ id: 'a.ts::foo' }), node({ id: 'a.ts::bar', fanIn: 1 })], [edge('a.ts::foo', 'a.ts::bar')]),
    } as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      selectedTests: unknown[]; coverage: { testDetection: string }; soundness: { caveats: string[] };
    };
    expect(r.selectedTests).toEqual([]);
    expect(r.coverage.testDetection).toBe('none');
    expect(r.soundness.caveats.join(' ')).toMatch(/no tests were detected/i);
  });

  it('defaults to a working-tree diff vs HEAD when no args are given, and flags it', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [{ path: 'src/foo.ts' }] } as never);
    const r = await handleSelectTests({ directory: '/p' }) as {
      selectedTests: Array<{ test: string }>; note?: string;
    };
    // src/foo.ts changed → seeds foo+bar → both tests reach the change.
    expect(r.selectedTests.map(t => t.test).sort()).toEqual(['testBar', 'testFoo']);
    expect(getChangedFiles).toHaveBeenCalledWith(expect.objectContaining({ baseRef: 'HEAD' }));
    expect(r.note).toMatch(/HEAD/);
  });

  it('flags the default in the empty-diff message when no args and no changes', async () => {
    vi.mocked(getChangedFiles).mockResolvedValueOnce({ files: [] } as never);
    const r = await handleSelectTests({ directory: '/p' }) as { selectedTests: unknown[]; message?: string; note?: string };
    expect(r.selectedTests).toEqual([]);
    expect(r.message).toMatch(/defaulted/);
    expect(r.note).toMatch(/HEAD/);
  });

  it('returns a message (not a false-empty) when symbols match no production function', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as { selectedTests: unknown[]; message?: string };
    expect(r.selectedTests).toEqual([]);
    expect(r.message).toBeTruthy();
  });

  // Honesty: opting into federation but resolving no local seed must explain why no
  // cross-repo selection ran, not silently omit the federation surface.
  it('discloses a federationNote when federation is requested but no seed resolves', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'], federation: true }) as { federationNote?: string };
    expect(r.federationNote).toMatch(/federation/i);
    const plain = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as { federationNote?: string };
    expect(plain.federationNote).toBeUndefined();
  });

  it('errors cleanly when no analysis is cached', async () => {
    vi.mocked(readCachedContext).mockResolvedValueOnce(null as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as { error: string };
    expect(r.error).toMatch(/analyze_codebase/);
  });

  // confidenceBoundary wiring (spec: add-confidence-boundary-disclosure). The fixture
  // dir has no fingerprint artifact → staleness silent, so `complete` tracks the basis.
  it('attaches a complete confidenceBoundary on an all-direct selection', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      confidenceBoundary: { complete: boolean; basis: { directEdges: number; synthesizedEdges: number } };
    };
    expect(r.confidenceBoundary.complete).toBe(true);
    expect(r.confidenceBoundary.basis.synthesizedEdges).toBe(0);
  });

  it('reports incomplete when a test reaches the change through a synthesized edge', async () => {
    const synthEdges: CallEdge[] = [
      { callerId: 'src/foo.test.ts::testFoo', calleeId: 'src/foo.ts::foo', calleeName: 'foo', confidence: 'synthesized', kind: 'calls', synthesizedBy: 'route-handler' },
      ...EDGES.slice(1),
    ];
    vi.mocked(readCachedContext).mockResolvedValue({ callGraph: graph(NODES, synthEdges) } as never);
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['bar'] }) as {
      confidenceBoundary: { complete: boolean; knownUnknowable: Array<{ rule?: string }> };
    };
    expect(r.confidenceBoundary.complete).toBe(false);
    expect(r.confidenceBoundary.knownUnknowable.some(c => c.rule === 'route-handler')).toBe(true);
  });

  it('attaches a confidenceBoundary on the no-seed (message) result', async () => {
    const r = await handleSelectTests({ directory: '/p', changedSymbols: ['doesNotExist'] }) as {
      selectedTests: unknown[]; confidenceBoundary: { complete: boolean };
    };
    expect(r.selectedTests).toEqual([]);
    expect(typeof r.confidenceBoundary.complete).toBe('boolean');
  });
});

describe('seed resolution helpers', () => {
  const cg = graph(NODES, EDGES);
  it('seedsFromSymbols prefers exact names and excludes tests', () => {
    expect(seedsFromSymbols(cg, ['bar']).map(n => n.id)).toEqual(['src/foo.ts::bar']);
    expect(seedsFromSymbols(cg, ['testFoo'])).toEqual([]); // tests are never seeds
  });
  it('seedsFromFiles matches by tolerant path and excludes tests', () => {
    const seeds = seedsFromFiles(cg, ['src/foo.ts']).map(n => n.name).sort();
    expect(seeds).toEqual(['bar', 'foo']);
    expect(seedsFromFiles(cg, ['/abs/repo/src/foo.ts']).length).toBe(2); // absolute form
  });
});

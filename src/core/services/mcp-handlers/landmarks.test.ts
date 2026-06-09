/**
 * Tests for handleGetLandmarks + the get_landmarks tool surface placement.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
}));
// Control the dead-code classifier so the handler test is deterministic.
vi.mock('./reachability.js', () => ({ deadCodeIds: vi.fn(async () => new Set<string>()) }));

import { handleGetLandmarks } from './landmarks.js';
import { readCachedContext } from './utils.js';
import { TOOL_PRESETS } from '../../../cli/commands/mcp.js';
import { TOOL_OUTPUT_CLASS } from './tool-contract.js';
import type { FunctionNode, SerializedCallGraph } from '../../analyzer/call-graph.js';

const mockCtx = vi.mocked(readCachedContext);

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...over,
  };
}
function graph(nodes: FunctionNode[], over: Partial<SerializedCallGraph> = {}): SerializedCallGraph {
  return {
    nodes, edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
    layerViolations: [], stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 }, ...over,
  };
}

describe('handleGetLandmarks', () => {
  beforeEach(() => vi.clearAllMocks());

  it('errors when no call graph is cached', async () => {
    mockCtx.mockResolvedValue(null as never);
    const r = await handleGetLandmarks('/p') as { error: string };
    expect(r.error).toMatch(/No call graph/);
  });

  it('returns labeled landmarks with evidence, counts, and no composite score', async () => {
    const hub = node({ id: 'a.ts::hubFn', fanIn: 40, fanOut: 2 });
    const orch = node({ id: 'b.ts::orchestrate', fanIn: 1, fanOut: 11 });
    const entry = node({ id: 'c.ts::main', fanIn: 0, fanOut: 4 });
    mockCtx.mockResolvedValue({ callGraph: graph([hub, orch, entry], { hubFunctions: [hub], entryPoints: [entry] }) } as never);

    const r = await handleGetLandmarks('/p') as {
      total: number; labelCounts: Record<string, number>; orderedBy: string;
      landmarks: Array<{ id: string; name: string; file: string; signals: Array<{ label: string; evidence: unknown }> }>;
    };
    const names = r.landmarks.map(l => l.name);
    expect(names).toEqual(expect.arrayContaining(['hubFn', 'orchestrate', 'main']));
    expect(r.total).toBe(3);
    expect(r.landmarks[0].name).toBe('hubFn'); // ordered by fanIn desc
    expect(r.labelCounts.hub).toBe(1);
    expect(r.labelCounts.chokepoint).toBe(1); // hub ∧ ¬orchestrator
    expect(JSON.stringify(r.landmarks)).not.toMatch(/"score"|"salience"/);
    // each landmark exposes its node id so it can be routed to via find_path's landmark:<id>
    expect(r.landmarks.every(l => typeof l.id === 'string' && l.id.length > 0)).toBe(true);
  });

  it('filters to a single label', async () => {
    const hub = node({ id: 'a.ts::hubFn', fanIn: 40, fanOut: 2 });
    const entry = node({ id: 'c.ts::main', fanIn: 0, fanOut: 4 });
    mockCtx.mockResolvedValue({ callGraph: graph([hub, entry], { hubFunctions: [hub], entryPoints: [entry] }) } as never);
    const r = await handleGetLandmarks('/p', { label: 'entrypoint' }) as { landmarks: Array<{ name: string }> };
    expect(r.landmarks.map(l => l.name)).toEqual(['main']);
  });

  it('rejects an unknown label', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([]) } as never);
    const r = await handleGetLandmarks('/p', { label: 'bogus' }) as { error: string };
    expect(r.error).toMatch(/Unknown label/);
  });
});

describe('get_landmarks tool surface', () => {
  it('is classified conclusion under the contract', () => {
    expect(TOOL_OUTPUT_CLASS.get_landmarks).toBe('conclusion');
  });
  it('is in the opt-in navigation preset, not the minimal default', () => {
    expect(TOOL_PRESETS.navigation.has('get_landmarks')).toBe(true);
    expect(TOOL_PRESETS.minimal.has('get_landmarks')).toBe(false);
  });
});

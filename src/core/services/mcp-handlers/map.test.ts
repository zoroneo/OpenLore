/**
 * Tests for handleGetMap (region view + drill-in) and the get_map tool surface.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./utils.js', () => ({
  notReadyResult: (error: string, reason: string) => ({ error, notReady: true, reason, remedy: 'openlore analyze' }),
  validateDirectory: vi.fn(async (dir: string) => dir),
  readCachedContext: vi.fn(async () => null),
}));

import { handleGetMap } from './map.js';
import { readCachedContext } from './utils.js';
import { TOOL_PRESETS } from '../../../cli/commands/mcp.js';
import { TOOL_OUTPUT_CLASS, assertConclusionShape } from './tool-contract.js';
import type { FunctionNode, CallEdge, SerializedCallGraph } from '../../analyzer/call-graph.js';

const mockCtx = vi.mocked(readCachedContext);

function node(over: Partial<FunctionNode> & { id: string }): FunctionNode {
  return {
    name: over.id.split('::')[1] ?? over.id, filePath: over.id.split('::')[0] ?? 'x.ts',
    isAsync: false, language: 'typescript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...over,
  };
}
function edge(callerId: string, calleeId: string): CallEdge {
  return { callerId, calleeId, calleeName: calleeId.split('::')[1] ?? calleeId, confidence: 'import', kind: 'calls' };
}
function graph(nodes: FunctionNode[], edges: CallEdge[]): SerializedCallGraph {
  return {
    nodes, edges, classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
    layerViolations: [], stats: { totalNodes: nodes.length, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

const a1 = node({ id: 'a.ts::a1', communityId: 'A', communityLabel: 'Region A', fanIn: 9, signature: 'a1()' });
const a2 = node({ id: 'a.ts::a2', communityId: 'A', communityLabel: 'Region A', fanIn: 1, signature: 'a2()' });
const b1 = node({ id: 'b.ts::b1', communityId: 'B', communityLabel: 'Region B', fanIn: 2, signature: 'b1()' });

describe('handleGetMap', () => {
  beforeEach(() => vi.clearAllMocks());

  it('errors when no call graph is cached', async () => {
    mockCtx.mockResolvedValue(null as never);
    expect((await handleGetMap('/p') as { error: string }).error).toMatch(/No call graph/);
  });

  it('region view returns super-nodes + super-edges and no function bodies', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([a1, a2, b1], [edge(a1.id, b1.id)]) } as never);
    const r = await handleGetMap('/p') as {
      regionCount: number; regions: Array<{ communityId: string; label: string; members: number; topLandmark: string }>;
      connections: Array<{ fromCommunity: string; toCommunity: string; callCount: number }>;
    };
    expect(r.regionCount).toBe(2);
    expect(r.regions.map(x => x.communityId).sort()).toEqual(['A', 'B']);
    expect(r.regions.find(x => x.communityId === 'A')!.topLandmark).toBe('a1');
    expect(r.connections).toEqual([{ fromCommunity: 'A', toCommunity: 'B', callCount: 1 }]);
    // region view carries no function-granularity payload
    expect(JSON.stringify(r)).not.toMatch(/"functions"|"signature"|"body"/);
    // conclusion-shaped (no nodes[]+edges[] join; resolved super-edges, not id-reference)
    assertConclusionShape('get_map', r);
  });

  it('drilling in with a communityId returns the function-granularity view (get_cluster shape)', async () => {
    mockCtx.mockResolvedValue({ callGraph: graph([a1, a2, b1], [edge(a1.id, a2.id)]) } as never);
    const r = await handleGetMap('/p', 'A') as {
      communityId: string; functions: Array<{ name: string }>; stats: { members: number };
    };
    expect(r.communityId).toBe('A');
    expect(r.stats.members).toBe(2);
    expect(r.functions.map(f => f.name).sort()).toEqual(['a1', 'a2']);
  });

  it('reports no-community-data when communities are absent', async () => {
    const plain = node({ id: 'z.ts::z' }); // no communityId
    mockCtx.mockResolvedValue({ callGraph: graph([plain], []) } as never);
    expect((await handleGetMap('/p') as { error: string }).error).toMatch(/No community data/);
  });
});

describe('get_map tool surface', () => {
  it('is classified conclusion under the contract', () => {
    expect(TOOL_OUTPUT_CLASS.get_map).toBe('conclusion');
  });
  it('is in the opt-in navigation preset, not the minimal default', () => {
    expect(TOOL_PRESETS.navigation.has('get_map')).toBe(true);
    expect(TOOL_PRESETS.minimal.has('get_map')).toBe(false);
  });
});

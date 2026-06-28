/**
 * get_map (change: add-hierarchical-map-navigation).
 *
 * A coarse-to-fine map of the call graph. With no `communityId` it returns the
 * REGION tier — communities as bounded super-nodes plus weighted inter-region
 * super-edges, and no function bodies — the high-level "lay of the land". With a
 * `communityId` it drills into one region at function granularity, reusing the
 * proven `get_cluster` view. Lets an agent plan region-to-region, then descend,
 * instead of stitching many `get_subgraph` calls.
 */

import { relative } from 'node:path';
import { validateDirectory, readCachedContext, notReadyResult } from './utils.js';
import { buildClusterView } from './analysis.js';
import { buildClusterGraph } from '../../analyzer/cluster-graph.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

/** Max regions returned in the region view before truncation (top-K by member count). */
const MAP_MAX_REGIONS = 40;

export async function handleGetMap(directory: string, communityId?: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return notReadyResult('No call graph. Run analyze_codebase first.', 'index-absent');
  const cg = ctx.callGraph as SerializedCallGraph;

  // Drill-in: function-granularity view of one region (same shape as get_cluster).
  if (communityId) return buildClusterView(cg, absDir, communityId);

  // Region tier: super-nodes + super-edges only.
  const { superNodes, superEdges } = buildClusterGraph(cg);
  if (superNodes.length === 0) {
    return { error: 'No community data. Re-run analyze_codebase to compute communities.' };
  }

  const ranked = [...superNodes].sort(
    (a, b) => b.memberCount - a.memberCount || a.communityId.localeCompare(b.communityId),
  );
  const kept = ranked.slice(0, MAP_MAX_REGIONS);
  const keptIds = new Set(kept.map(s => s.communityId));

  // Keep only super-edges between kept regions so the map stays self-consistent.
  const connections = superEdges
    .filter(e => keptIds.has(e.fromCommunity) && keptIds.has(e.toCommunity))
    .sort((a, b) => b.callCount - a.callCount || a.fromCommunity.localeCompare(b.fromCommunity));

  return {
    regionCount: superNodes.length,
    returned: kept.length,
    truncated: superNodes.length > MAP_MAX_REGIONS ? superNodes.length - MAP_MAX_REGIONS : 0,
    regions: kept.map(s => ({
      communityId: s.communityId,
      label: s.label,
      members: s.memberCount,
      files: s.fileCount,
      topFiles: s.topFiles.map(f => relative(absDir, f)),
      topLandmark: s.topLandmark,
    })),
    connections,
    hint: 'Call get_map with a communityId to drill into a region at function granularity.',
  };
}

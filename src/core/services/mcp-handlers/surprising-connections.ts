import { validateDirectory, readCachedContext } from './utils.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

const DEFAULT_LIMIT = 15;
const HUB_MIN_FAN_IN = 5;
const PERIPHERAL_MAX_DEGREE = 4;

export interface GetSurprisingConnectionsInput {
  directory: string;
  /** Max results to return (default: 15, max: 50). */
  limit?: number;
}

export async function handleGetSurprisingConnections(input: GetSurprisingConnectionsInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 50));
  const cg = ctx.callGraph as SerializedCallGraph;
  const nodeById = new Map<string, FunctionNode>(cg.nodes.map(n => [n.id, n]));

  // Deduplicate: one entry per (callerId, calleeId) pair.
  const seen = new Set<string>();
  const results: Array<{
    from: string; fromFile: string;
    to: string; toFile: string;
    score: number; reasons: string[];
  }> = [];

  for (const e of cg.edges) {
    const key = `${e.callerId}→${e.calleeId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const src = nodeById.get(e.callerId);
    const tgt = nodeById.get(e.calleeId);
    if (!src || !tgt || src.isExternal || tgt.isExternal) continue;

    const reasons: string[] = [];
    let score = 0;

    // Cross-community: different non-null community IDs
    if (src.communityId && tgt.communityId && src.communityId !== tgt.communityId) {
      score += 0.3;
      reasons.push('cross-community');
    }

    // Peripheral-to-hub: low-degree source calling a high-fanIn target
    const srcDegree = (src.fanIn ?? 0) + (src.fanOut ?? 0);
    if (srcDegree <= PERIPHERAL_MAX_DEGREE && (tgt.fanIn ?? 0) >= HUB_MIN_FAN_IN * 3) {
      score += 0.2;
      reasons.push('peripheral-to-hub');
    }

    // Cross-test-boundary: one side is test, the other is not
    if (!!src.isTest !== !!tgt.isTest) {
      score += 0.15;
      reasons.push('cross-test-boundary');
    }

    if (score === 0) continue;

    results.push({
      from: src.name,
      fromFile: src.filePath,
      to: tgt.name,
      toFile: tgt.filePath,
      score: Math.round(score * 100) / 100,
      reasons,
    });
  }

  const top = results.sort((a, b) => b.score - a.score).slice(0, limit);

  return {
    count: top.length,
    connections: top,
    guidance:
      'Each connection is scored by: cross-community (+0.3), peripheral-to-hub (+0.2), ' +
      'cross-test-boundary (+0.15). High scores flag accidental coupling. ' +
      'Verify with get_subgraph or trace_execution_path before acting.',
  };
}

/**
 * find_path (change: add-landmark-pathfinding).
 *
 * Goal-conditioned navigation: "get from A to B". Endpoints may be exact/fuzzy
 * names OR selectors (`landmark:<id>`, `role:entrypoint|hub|sink`, `file:<path>`),
 * so an agent can route by KIND of endpoint without naming both ends. Returns the
 * single CHEAPEST call path (by call-distance, or fewest hops if disabled) plus a
 * bounded set of alternates and a stated reason -- never a raw multi-path dump.
 *
 * Extends, not replaces, trace_execution_path: reuses its name-matching and the
 * weighted traversal (weightedBfs) from add-call-distance-scoping.
 */

import { relative } from 'node:path';
import { validateDirectory, readCachedContext } from './utils.js';
import { buildAdjacency, buildWeightedAdjacency, weightedBfs } from './graph.js';
import type { WeightedReach } from './graph.js';
import { SUBGRAPH_MAX_DEPTH_LIMIT } from '../../../constants.js';
import type { SerializedCallGraph, FunctionNode } from '../../analyzer/call-graph.js';

export const MAX_ALTERNATES = 3;
/** Cost budget for the call-distance traversal (a path beyond this is "too far"). */
const PATH_MAX_DISTANCE = 12;

export type EndpointKind = 'name' | 'landmark' | 'role:entrypoint' | 'role:hub' | 'role:sink' | 'file' | 'error';

export interface ResolvedEndpoint {
  kind: EndpointKind;
  nodes: FunctionNode[];
}

/**
 * Resolve an endpoint spec to concrete functions. Each `role` resolves through an
 * EXISTING classifier with no new threshold; `sink` is parameter-free (a called
 * leaf: zero outgoing internal call edges AND fan-in >= 1).
 */
export function resolveEndpoint(
  spec: string,
  cg: SerializedCallGraph,
  forward: Map<string, Set<string>>,
): ResolvedEndpoint {
  const real = (ns: FunctionNode[]) => ns.filter(n => !n.isExternal && !n.isTest);

  if (spec.startsWith('role:')) {
    const role = spec.slice(5);
    if (role === 'entrypoint') return { kind: 'role:entrypoint', nodes: real(cg.entryPoints) };
    if (role === 'hub') return { kind: 'role:hub', nodes: real(cg.hubFunctions) };
    if (role === 'sink') {
      // A called leaf: terminates an internal call chain and has at least one caller.
      const nodes = real(cg.nodes).filter(n => (n.fanIn ?? 0) >= 1 && (forward.get(n.id)?.size ?? 0) === 0);
      return { kind: 'role:sink', nodes };
    }
    return { kind: 'error', nodes: [] };
  }
  if (spec.startsWith('landmark:')) {
    const key = spec.slice(9).toLowerCase();
    const exact = real(cg.nodes).filter(n => n.id.toLowerCase() === key || n.name.toLowerCase() === key);
    const nodes = exact.length > 0 ? exact : real(cg.nodes).filter(n => n.id.toLowerCase().includes(key));
    return { kind: 'landmark', nodes };
  }
  if (spec.startsWith('file:')) {
    const p = spec.slice(5).replace(/^\/+/, '').toLowerCase();
    return { kind: 'file', nodes: real(cg.nodes).filter(n => n.filePath.toLowerCase().includes(p)) };
  }
  // exact / fuzzy name (case-insensitive substring, like trace_execution_path)
  const low = spec.toLowerCase();
  return { kind: 'name', nodes: real(cg.nodes).filter(n => n.name.toLowerCase().includes(low)) };
}

export interface PathResult {
  found: boolean;
  /** Cheapest path, when found. */
  best?: { ids: string[]; hops: number; distance: number };
  /** Up to MAX_ALTERNATES next-best paths (to other resolved to-seeds). */
  alternates: Array<{ ids: string[]; hops: number; distance: number }>;
  /** How many nodes the search reached (for the no-path answer). */
  reached: number;
}

/** Convert a node->Set adjacency to unit-cost weighted adjacency (distance == hops). */
function unitAdjacency(forward: Map<string, Set<string>>): Map<string, Array<{ to: string; cost: number }>> {
  const out = new Map<string, Array<{ to: string; cost: number }>>();
  for (const [k, set] of forward) out.set(k, [...set].map(to => ({ to, cost: 1 })));
  return out;
}

function reconstruct(reach: Map<string, WeightedReach>, toId: string): { ids: string[]; hops: number; distance: number } {
  const ids: string[] = [];
  let cur: string | null = toId;
  while (cur) { ids.push(cur); cur = reach.get(cur)?.predecessor ?? null; }
  ids.reverse();
  const r = reach.get(toId)!;
  return { ids, hops: r.hops, distance: r.distance };
}

/**
 * Cheapest forward call path from any `from` seed to the nearest `to` seed. Uses
 * call-distance weights by default; unit (hop) costs when `useCallDistance` is
 * false. Returns the cheapest path plus up to MAX_ALTERNATES paths to other
 * reachable to-seeds.
 */
export function findCheapestPath(
  cg: SerializedCallGraph,
  fromSeeds: string[],
  toSeeds: string[],
  opts: { useCallDistance?: boolean; maxDistance?: number; forward?: Map<string, Set<string>> } = {},
): PathResult {
  const adjacency = opts.useCallDistance === false
    ? unitAdjacency(opts.forward ?? buildAdjacency(cg).forward)
    : buildWeightedAdjacency(cg).forward;
  const maxDistance = opts.useCallDistance === false
    ? SUBGRAPH_MAX_DEPTH_LIMIT
    : (opts.maxDistance ?? PATH_MAX_DISTANCE);

  const fromSet = new Set(fromSeeds);
  const reach = weightedBfs(fromSeeds, adjacency, maxDistance);

  const hits = toSeeds
    .filter(id => !fromSet.has(id) && reach.has(id))
    .map(id => reconstruct(reach, id))
    .sort((a, b) => a.distance - b.distance || a.hops - b.hops || a.ids.join().localeCompare(b.ids.join()));

  if (hits.length === 0) return { found: false, alternates: [], reached: reach.size };
  return { found: true, best: hits[0], alternates: hits.slice(1, 1 + MAX_ALTERNATES), reached: reach.size };
}

export async function handleFindPath(
  directory: string,
  from: string,
  to: string,
  opts: { useCallDistance?: boolean } = {},
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };
  const cg = ctx.callGraph as SerializedCallGraph;
  const { nodeMap, forward } = buildAdjacency(cg);

  const fromRes = resolveEndpoint(from, cg, forward);
  const toRes = resolveEndpoint(to, cg, forward);
  const SELECTOR_HELP = 'Use a function name, landmark:<id>, role:entrypoint|hub|sink, or file:<path>.';
  if (fromRes.kind === 'error') return { error: `Unknown "from" selector "${from}". ${SELECTOR_HELP}` };
  if (toRes.kind === 'error') return { error: `Unknown "to" selector "${to}". ${SELECTOR_HELP}` };
  if (fromRes.nodes.length === 0) return { error: `"${from}" resolved to no functions.` };
  if (toRes.nodes.length === 0) return { error: `"${to}" resolved to no functions.` };

  const describe = (r: ResolvedEndpoint, selector: string) => ({
    selector, kind: r.kind, matched: r.nodes.length, sample: r.nodes.slice(0, 5).map(n => n.name),
  });
  const resolvedFrom = describe(fromRes, from);
  const resolvedTo = describe(toRes, to);

  // Same-endpoint query: every resolved target is also a source — no traversal needed.
  const fromIds = new Set(fromRes.nodes.map(n => n.id));
  if (toRes.nodes.every(n => fromIds.has(n.id))) {
    return {
      from, to, resolvedFrom, resolvedTo, path: null,
      note: 'from and to resolve to the same function(s) — no path to compute.',
    };
  }

  const useCallDistance = opts.useCallDistance !== false;
  const result = findCheapestPath(cg, fromRes.nodes.map(n => n.id), toRes.nodes.map(n => n.id), { useCallDistance, forward });
  const toChain = (p: { ids: string[]; hops: number; distance: number }) => ({
    chain: p.ids.map(id => { const n = nodeMap.get(id); return { name: n?.name ?? id, file: n ? relative(absDir, n.filePath) : '' }; }),
    hops: p.hops,
    distance: useCallDistance ? p.distance : undefined,
  });

  if (!result.found) {
    return {
      from, to, resolvedFrom, resolvedTo, path: null,
      noPath: {
        reason: `No call path from "${from}" to "${to}" within ${useCallDistance ? `call-distance ${PATH_MAX_DISTANCE}` : `depth ${SUBGRAPH_MAX_DEPTH_LIMIT}`}.`,
        reachedNodes: result.reached,
        hint: 'The endpoints may be in different connected components, or only linked by a longer path — try the other endpoint kinds.',
      },
    };
  }

  const best = result.best!;
  return {
    from, to, resolvedFrom, resolvedTo,
    path: toChain(best),
    alternates: result.alternates.map(toChain),
    reason: useCallDistance
      ? `Cheapest by call-distance (cost ${best.distance}, ${best.hops} hops); ${result.alternates.length} alternate(s).`
      : `Fewest hops (${best.hops}); ${result.alternates.length} alternate(s).`,
  };
}

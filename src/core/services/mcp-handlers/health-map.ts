import { validateDirectory, readCachedContext } from './utils.js';
import type { SerializedCallGraph, FunctionNode, LayerViolation } from '../../analyzer/call-graph.js';
import { volatilityLevel } from '../../provenance/change-coupling.js';

const HUB_MIN_FAN_IN = 5;
const GOD_MIN_FAN_OUT = 8;
const DEFAULT_LIMIT = 10;

export interface GetHealthMapInput {
  directory: string;
  /** Max items per hotspot list and max topRisks (default 10, max 50). */
  limit?: number;
}

export async function handleGetHealthMap(input: GetHealthMapInput): Promise<unknown> {
  const absDir = await validateDirectory(input.directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx) return { error: 'No analysis found. Run analyze_codebase first.' };
  if (!ctx.callGraph) return { error: 'Call graph not available. Re-run analyze_codebase.' };

  const limit = Math.max(1, Math.min(input.limit ?? DEFAULT_LIMIT, 50));
  const cg = ctx.callGraph as SerializedCallGraph;
  const codeNodes = cg.nodes.filter(n => !n.isExternal && !n.isTest);

  // --- Hubs (high fan-in) ---
  const hubNodes = codeNodes
    .filter(n => (n.fanIn ?? 0) >= HUB_MIN_FAN_IN)
    .sort((a, b) => (b.fanIn ?? 0) - (a.fanIn ?? 0));

  // --- God functions (high fan-out) ---
  const godNodes = codeNodes
    .filter(n => (n.fanOut ?? 0) >= GOD_MIN_FAN_OUT)
    .sort((a, b) => (b.fanOut ?? 0) - (a.fanOut ?? 0));

  // --- Layer violations ---
  const nodeMap = new Map(cg.nodes.map(n => [n.id, n]));
  const violations = cg.layerViolations ?? [];
  const violationFiles = new Set<string>(
    violations.flatMap(v =>
      [nodeMap.get(v.callerId)?.filePath, nodeMap.get(v.calleeId)?.filePath].filter((p): p is string => p !== undefined)
    )
  );

  // --- Volatility (from edgeStore if present) ---
  // Fetch all volatile files to get the true total count; slice to limit for display.
  let allVolatileFiles: Array<{ file: string; level: string; changes: number }> = [];
  if (ctx.edgeStore && ctx.edgeStore.countChangeCoupling() > 0) {
    allVolatileFiles = ctx.edgeStore.getTopVolatile(10_000).map(r => ({
      file: r.filePath,
      level: volatilityLevel(r.churn),
      changes: r.churn,
    }));
  }
  const volatileFileList = allVolatileFiles.slice(0, limit);
  const volatileFileSet = new Set(allVolatileFiles.map(v => v.file));

  // --- Top risks: deduplicated union of hubs + god functions, ranked by severity ---
  const candidateMap = new Map(
    [...hubNodes.slice(0, limit), ...godNodes.slice(0, limit)].map(n => [n.id, n])
  );
  const topRisks = [...candidateMap.values()]
    .map(n => {
      const isHub = (n.fanIn ?? 0) >= HUB_MIN_FAN_IN;
      const isGod = (n.fanOut ?? 0) >= GOD_MIN_FAN_OUT;
      const isVolatile = volatileFileSet.has(n.filePath);
      const hasViolation = violationFiles.has(n.filePath);
      const reasons: string[] = [];
      if (isHub) reasons.push(`hub (${n.fanIn} callers)`);
      if (isGod) reasons.push(`god function (${n.fanOut} callees)`);
      if (isVolatile) reasons.push('volatile file');
      if (hasViolation) reasons.push('layer violation');
      const severity: 'critical' | 'high' | 'medium' =
        reasons.length >= 3 ? 'critical' : reasons.length >= 2 ? 'high' : 'medium';
      return {
        name: n.name,
        file: n.filePath,
        fanIn: n.fanIn ?? 0,
        fanOut: n.fanOut ?? 0,
        reasons,
        severity,
      };
    })
    .sort((a, b) => {
      const rank = { critical: 0, high: 1, medium: 2 } as const;
      return rank[a.severity] - rank[b.severity] || (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut);
    })
    .slice(0, limit);

  return {
    summary: {
      totalFunctions: codeNodes.length,
      hubCount: hubNodes.length,
      godFunctionCount: godNodes.length,
      layerViolationCount: violations.length,
      volatileFileCount: allVolatileFiles.length,
    },
    topRisks,
    hotspots: {
      hubs: hubNodes.slice(0, Math.min(limit, 5)).map(n => ({
        name: n.name,
        file: n.filePath,
        fanIn: n.fanIn ?? 0,
        fanOut: n.fanOut ?? 0,
      })),
      godFunctions: godNodes.slice(0, Math.min(limit, 5)).map(n => ({
        name: n.name,
        file: n.filePath,
        fanOut: n.fanOut ?? 0,
      })),
      volatile: volatileFileList.slice(0, Math.min(limit, 5)),
    },
    guidance:
      'topRisks covers structural hotspots (hubs + god functions) enriched with volatility and layer-violation signals. ' +
      'critical = ≥3 signals, high = 2, medium = 1. ' +
      'Volatile-only or violation-only files appear in hotspots.volatile but not in topRisks. ' +
      'Drill in with get_critical_hubs, get_god_functions, get_change_coupling, or find_dead_code.',
  };
}

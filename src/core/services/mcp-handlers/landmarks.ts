/**
 * get_landmarks (change: add-structural-landmark-salience).
 *
 * The whole-repo UNION of structural-interest signals as labels — the one call that
 * answers "with no task in hand, what are the structural anchors of this repo
 * (optionally just the hubs / just the volatile ones)?". Each existing per-signal
 * tool (`get_critical_hubs`, `get_god_functions`, …) returns only one signal; this
 * composes them, reusing their classifiers, and emits labels + evidence with no
 * blended salience score (ranking is the caller's). Conclusion-shaped per the
 * conclusion-over-graph tool contract.
 */

import { relative } from 'node:path';
import { validateDirectory, readCachedContext } from './utils.js';
import { deadCodeIds } from './reachability.js';
import { computeLandmarkSignals } from '../../analyzer/landmark-signals.js';
import type { LandmarkLabel } from '../../analyzer/landmark-signals.js';
import { volatilityLevel } from '../../provenance/change-coupling.js';
import type { SerializedCallGraph } from '../../analyzer/call-graph.js';

const LANDMARK_LIMIT_DEFAULT = 20;
const LANDMARK_LIMIT_MAX = 200;
const VALID_LABELS: LandmarkLabel[] = ['hub', 'orchestrator', 'chokepoint', 'volatile', 'entrypoint', 'dead'];

export async function handleGetLandmarks(
  directory: string,
  opts: { limit?: number; label?: string } = {},
): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const ctx = await readCachedContext(absDir);
  if (!ctx?.callGraph) return { error: 'No call graph. Run analyze_codebase first.' };
  const cg = ctx.callGraph as SerializedCallGraph;

  const label = opts.label as LandmarkLabel | undefined;
  if (label !== undefined && !VALID_LABELS.includes(label)) {
    return { error: `Unknown label "${opts.label}". Valid labels: ${VALID_LABELS.join(', ')}.` };
  }

  // volatile: per-file churn from the persisted change-coupling table (git-derived,
  // computed at analyze time). Absent on non-git repos → no volatile labels.
  const volatilityByFile = new Map<string, { level: 'high' | 'medium'; churn: number; coChangedWith: number }>();
  try {
    const top = ctx.edgeStore?.getTopVolatile(1000) ?? [];
    for (const v of top) {
      const level = volatilityLevel(v.churn);
      if (level !== 'low') volatilityByFile.set(v.filePath, { level, churn: v.churn, coChangedWith: v.coupledWith?.length ?? 0 });
    }
  } catch { /* no churn data — skip volatile labels */ }

  // dead: the reachability classifier shared with find_dead_code, narrowed to the
  // unambiguous case — a candidate with NO internal caller. find_dead_code also
  // surfaces transitively-dead candidates that still have callers (reachable only
  // from other dead code); those read as noise on a "structural anchor" label
  // (e.g. a 12-caller function tagged dead), so the landmark signal keeps only the
  // no-caller candidates, which are find_dead_code's highest-confidence ones.
  let deadIds: Set<string> | undefined;
  try {
    const candidates = await deadCodeIds(absDir, cg);
    const noCaller = new Set(cg.nodes.filter(n => (n.fanIn ?? 0) === 0).map(n => n.id));
    deadIds = new Set([...candidates].filter(id => noCaller.has(id)));
  } catch { /* skip dead labels */ }

  let landmarks = computeLandmarkSignals(cg, { volatilityByFile, deadIds });
  if (label !== undefined) landmarks = landmarks.filter(l => l.signals.some(s => s.label === label));

  // Deterministic ordering by a single transparent metric (fan-in) — NOT a blended
  // salience score; the agent re-ranks by task relevance using the evidence.
  const fanInById = new Map(cg.nodes.map(n => [n.id, n.fanIn ?? 0]));
  landmarks.sort((a, b) => (fanInById.get(b.id)! - fanInById.get(a.id)!) || a.id.localeCompare(b.id));

  const limit = Math.max(1, Math.min(opts.limit ?? LANDMARK_LIMIT_DEFAULT, LANDMARK_LIMIT_MAX));
  const labelCounts: Record<string, number> = {};
  for (const l of landmarks) for (const s of l.signals) labelCounts[s.label] = (labelCounts[s.label] ?? 0) + 1;

  return {
    total: landmarks.length,
    returned: Math.min(limit, landmarks.length),
    truncated: landmarks.length > limit ? landmarks.length - limit : 0,
    labelCounts,
    orderedBy: 'fanIn (single structural metric, not a salience score)',
    landmarks: landmarks.slice(0, limit).map(l => ({
      id: l.id, // pass to find_path as landmark:<id> to route to/from this anchor
      name: l.name,
      file: relative(absDir, l.filePath),
      signals: l.signals,
    })),
  };
}

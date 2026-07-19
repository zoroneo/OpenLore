/**
 * Observe-mode validation — the accuracy gate for the agent behavioral governance layer.
 *
 * Deterministic, read-only analysis over panic telemetry (`panic.jsonl`). It produces the
 * evidence a maintainer needs to decide whether the panic SIGNAL is accurate enough to act on,
 * BEFORE any interventional posture (default advisory injection, experimental_blocking,
 * auto-installed hooks) is turned on by default.
 *
 * The `verdict` is a MECHANICAL read of the criteria, never an activation: it is CLEARED only when
 * every gate criterion is met, REVIEW_REQUIRED when there is enough data but a criterion is unmet,
 * and INSUFFICIENT_DATA below the episode floor. CLEARED does NOT turn anything on — activating an
 * interventional posture is still a human decision (`setup --panic …`, which consults this verdict
 * and requires an explicit acknowledgement to proceed when it is not CLEARED).
 *
 * No LLM, no heuristics beyond counting — the north-star determinism constraint holds.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../../constants.js';
import { MAX_ROTATED_FILES } from '../telemetry.js';

/** A panic.jsonl record (subset of fields this analysis reads). */
export interface PanicTelemetryEvent {
  ts: string;
  event: string;
  from_level?: number;
  to_level?: number;
  delta?: number;
  outcome?: string;
  /** panic_score_delta carries per-trigger provenance under `triggers`. */
  triggers?: Array<{ name: string; delta: number }>;
  /** panic_level_change carries it under `provenance`. */
  provenance?: Array<{ name: string; delta: number }>;
}

/** Gate thresholds — single source of truth, referenced by tests and the report. */
export const PANIC_GATE = {
  /** Minimum completed episodes before the gate is even evaluable. */
  MIN_EPISODES: 20,
  /** False-positive proxy at/below this is acceptable (lower is better). */
  FP_PROXY_TARGET: 0.2,
  /** Intervention follow-through at/above this is acceptable (higher is better). */
  FOLLOW_THROUGH_TARGET: 0.5,
  /** A single trigger firing in at/above this share of false positives is "noisy". */
  NOISY_TRIGGER_FP_SHARE: 0.5,
} as const;

export type PanicGateVerdict = 'INSUFFICIENT_DATA' | 'REVIEW_REQUIRED' | 'CLEARED';

export interface PanicGateReport {
  /** CLEARED only when every criterion is met — a mechanical read, never an activation. */
  verdict: PanicGateVerdict;
  min_episodes: number;
  episodes: { total: number; completed: number; open: number };
  peak_level_histogram: Record<'L1' | 'L2' | 'L3' | 'L4', number>;
  false_positive: {
    /**
     * UPPER BOUND, not a true false-positive rate: the share of completed episodes that resolved
     * WITHOUT the agent re-orienting (resolved-by-decay). Some of those were genuine panics the
     * agent worked through without an explicit orient() — so this over-counts false positives by
     * construction. Presented as a proxy everywhere it surfaces; never labeled a true FP rate.
     */
    proxy_rate: number | null;
    resolved_via_orient: number;
    resolved_via_decay: number;
    /** false-positive episodes that peaked at L3+ (the worst kind). */
    high_level_count: number;
    /** per-trigger: how often it appears in false-positive episodes vs all episodes. */
    by_trigger: Array<{ trigger: string; fp_episodes: number; all_episodes: number; fp_share: number }>;
  };
  intervention: {
    hook_intercepts: number;
    responses: number;
    follow_through_rate: number | null;
    avg_response_lag_ms: number | null;
  };
  resolution: {
    completed_rate: number | null;
    /** episodes that re-opened within 60s of a prior episode ending (thrash). */
    recurrence_count: number;
    avg_recovery_ms: number | null;
  };
  /** Which gate criteria are met right now (verdict stays REVIEW_REQUIRED regardless). */
  criteria: { data_sufficient: boolean; fp_ok: boolean | null; follow_through_ok: boolean | null };
  /** Human-readable, actionable reasons — what blocks the gate and why. */
  recommendations: string[];
}

interface Episode {
  start: string;
  end?: string;
  peak: number;
  triggers: Set<string>;
  resolvedViaOrient: boolean;
}

const RECURRENCE_WINDOW_MS = 60_000;

/**
 * Compute the panic-signal accuracy gate from panic.jsonl events.
 */
export function validatePanicSignal(events: PanicTelemetryEvent[]): PanicGateReport {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const levelChanges = sorted.filter((e) => e.event === 'panic_level_change');
  const orientResets = sorted.filter((e) => e.event === 'panic_orient_reset' && (e.delta ?? 0) < 0);
  const scoreDeltas = sorted.filter((e) => e.event === 'panic_score_delta');

  // ── Build episodes: 0→>0 ... →0 ────────────────────────────────────────────
  const episodes: Episode[] = [];
  let cur: Episode | null = null;
  for (const e of levelChanges) {
    const from = e.from_level ?? 0;
    const to = e.to_level ?? 0;
    if (!cur && from === 0 && to > 0) {
      cur = { start: e.ts, peak: to, triggers: new Set(), resolvedViaOrient: false };
    } else if (cur) {
      if (to > cur.peak) cur.peak = to;
      if (to === 0) {
        cur.end = e.ts;
        episodes.push(cur);
        cur = null;
      }
    }
  }
  if (cur) episodes.push(cur);

  // Attach the triggers (from panic_score_delta provenance) and orient-resolution per episode.
  for (const ep of episodes) {
    const within = (ts: string) => ts >= ep.start && (ep.end === undefined || ts <= ep.end);
    for (const sd of scoreDeltas) {
      if (!within(sd.ts)) continue;
      for (const t of sd.triggers ?? []) {
        // upward (panic-raising) triggers only; ignore entries with no string name (malformed telemetry)
        if (t.delta > 0 && typeof t.name === 'string' && t.name) ep.triggers.add(t.name);
      }
    }
    ep.resolvedViaOrient = orientResets.some((o) => within(o.ts));
  }

  const completed = episodes.filter((e) => e.end);
  const resolvedViaOrient = completed.filter((e) => e.resolvedViaOrient).length;
  const resolvedViaDecay = completed.length - resolvedViaOrient;
  const fpProxyRate = completed.length ? resolvedViaDecay / completed.length : null;

  // Peak-level histogram
  const hist: Record<'L1' | 'L2' | 'L3' | 'L4', number> = { L1: 0, L2: 0, L3: 0, L4: 0 };
  for (const e of episodes) {
    const k = (`L${Math.min(4, Math.max(1, e.peak))}`) as 'L1' | 'L2' | 'L3' | 'L4';
    hist[k]++;
  }

  // FP episodes = completed + resolved-via-decay (a proxy for "panic raised, no correction needed")
  const fpEpisodes = completed.filter((e) => !e.resolvedViaOrient);
  const highLevelFp = fpEpisodes.filter((e) => e.peak >= 3).length;

  // Per-trigger attribution: how often each trigger appears in FP episodes vs all episodes.
  const allByTrigger = new Map<string, number>();
  const fpByTrigger = new Map<string, number>();
  for (const e of episodes) for (const t of e.triggers) allByTrigger.set(t, (allByTrigger.get(t) ?? 0) + 1);
  for (const e of fpEpisodes) for (const t of e.triggers) fpByTrigger.set(t, (fpByTrigger.get(t) ?? 0) + 1);
  const byTrigger = [...allByTrigger.entries()]
    .map(([trigger, all]) => {
      const fp = fpByTrigger.get(trigger) ?? 0;
      return { trigger, fp_episodes: fp, all_episodes: all, fp_share: all ? fp / all : 0 };
    })
    .sort((a, b) => b.fp_share - a.fp_share || b.all_episodes - a.all_episodes);

  // Intervention follow-through
  const hookIntercepts = sorted.filter((e) => e.event === 'hook_intervention').length;
  const outcomes = sorted.filter((e) => e.event === 'panic_intervention_outcome' && e.outcome === 'responded');
  const responses = outcomes.length;
  const followThrough = hookIntercepts ? responses / hookIntercepts : null;
  const lags = outcomes.map((e) => e.delta).filter((d): d is number => typeof d === 'number');
  const avgLag = lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : null;

  // Resolution
  const completedRate = episodes.length ? completed.length / episodes.length : null;
  const recoveryMs = completed
    .map((e) => new Date(e.end!).getTime() - new Date(e.start).getTime())
    .filter((ms) => ms >= 0);
  const avgRecovery = recoveryMs.length ? Math.round(recoveryMs.reduce((a, b) => a + b, 0) / recoveryMs.length) : null;
  // Recurrence: an episode starting within RECURRENCE_WINDOW_MS of the previous episode's end.
  let recurrence = 0;
  for (let i = 1; i < episodes.length; i++) {
    const prevEnd = episodes[i - 1].end;
    if (!prevEnd) continue;
    if (new Date(episodes[i].start).getTime() - new Date(prevEnd).getTime() <= RECURRENCE_WINDOW_MS) recurrence++;
  }

  // ── Verdict + criteria + recommendations ───────────────────────────────────
  const dataSufficient = completed.length >= PANIC_GATE.MIN_EPISODES;
  const fpOk = fpProxyRate === null ? null : fpProxyRate <= PANIC_GATE.FP_PROXY_TARGET;
  const ftOk = followThrough === null ? null : followThrough >= PANIC_GATE.FOLLOW_THROUGH_TARGET;
  // CLEARED requires EVERY criterion affirmatively met — a null (unmeasured) follow-through is not
  // "met", so pure observe-mode (no interventions yet) never clears. Still mechanical, never an
  // activation: setup consults this and requires an explicit acknowledgement to act when not CLEARED.
  const cleared = dataSufficient && fpOk === true && ftOk === true;
  const verdict: PanicGateVerdict = cleared ? 'CLEARED' : dataSufficient ? 'REVIEW_REQUIRED' : 'INSUFFICIENT_DATA';

  const recs: string[] = [];
  if (!dataSufficient) {
    recs.push(
      `Insufficient data: ${completed.length}/${PANIC_GATE.MIN_EPISODES} completed episodes. ` +
        `Run mode:'observe' on real sessions to gather more before evaluating the gate.`,
    );
  }
  if (fpOk === false) {
    recs.push(
      `False-positive proxy ${(fpProxyRate! * 100).toFixed(0)}% exceeds the ${(PANIC_GATE.FP_PROXY_TARGET * 100).toFixed(0)}% target ` +
        `(${resolvedViaDecay}/${completed.length} episodes resolved without re-orient). The signal raises panic on work that did not need correcting.`,
    );
  }
  for (const t of byTrigger) {
    if (t.all_episodes >= 3 && t.fp_share >= PANIC_GATE.NOISY_TRIGGER_FP_SHARE) {
      recs.push(
        `Trigger '${t.trigger}' is noisy: fires in ${(t.fp_share * 100).toFixed(0)}% of its episodes that were false positives ` +
          `(${t.fp_episodes}/${t.all_episodes}). Consider raising its threshold before acting on it.`,
      );
    }
  }
  if (highLevelFp > 0) {
    recs.push(`${highLevelFp} false-positive episode(s) peaked at L3+ — high-confidence panic on coherent work is the most damaging failure mode.`);
  }
  if (ftOk === false) {
    recs.push(
      `Intervention follow-through ${(followThrough! * 100).toFixed(0)}% is below the ${(PANIC_GATE.FOLLOW_THROUGH_TARGET * 100).toFixed(0)}% target ` +
        `(${responses}/${hookIntercepts} intercepts led to an orient). Agents are ignoring or fighting the nudge.`,
    );
  }
  if (cleared && recs.length === 0) {
    recs.push(
      `Gate CLEARED — every criterion meets target (fp-proxy ≤ ${(PANIC_GATE.FP_PROXY_TARGET * 100).toFixed(0)}% [upper bound], follow-through ≥ ${(PANIC_GATE.FOLLOW_THROUGH_TARGET * 100).toFixed(0)}%). ` +
        `You may now enable an interventional posture with \`setup --panic advisory|experimental_blocking\`. CLEARED reports the criteria are met; it does not activate anything.`,
    );
  }

  return {
    verdict,
    min_episodes: PANIC_GATE.MIN_EPISODES,
    episodes: { total: episodes.length, completed: completed.length, open: episodes.length - completed.length },
    peak_level_histogram: hist,
    false_positive: {
      proxy_rate: fpProxyRate,
      resolved_via_orient: resolvedViaOrient,
      resolved_via_decay: resolvedViaDecay,
      high_level_count: highLevelFp,
      by_trigger: byTrigger,
    },
    intervention: {
      hook_intercepts: hookIntercepts,
      responses,
      follow_through_rate: followThrough,
      avg_response_lag_ms: avgLag,
    },
    resolution: { completed_rate: completedRate, recurrence_count: recurrence, avg_recovery_ms: avgRecovery },
    criteria: { data_sufficient: dataSufficient, fp_ok: fpOk, follow_through_ok: ftOk },
    recommendations: recs,
  };
}

/**
 * Read all panic telemetry for a project, spanning the live file AND its rotated archives.
 *
 * Telemetry rotates the live `panic.jsonl` into numbered archives (`panic.1.jsonl` … up to
 * `panic.<MAX_ROTATED_FILES>.jsonl`) once it exceeds the size threshold. Reading only the live file
 * silently discards episodes on a long-running observation loop, so the gate's MIN_EPISODES floor
 * could stay unreachable forever. This reads the oldest archive first through the live file last, so
 * events arrive roughly in order (validatePanicSignal re-sorts by ts regardless). Malformed lines
 * are skipped; a missing file contributes nothing. Never throws.
 */
export function readPanicTelemetry(directory: string): PanicTelemetryEvent[] {
  const base = join(directory, OPENLORE_DIR, 'telemetry', 'panic');
  // Oldest → newest: panic.N.jsonl … panic.1.jsonl, then the live panic.jsonl.
  const files: string[] = [];
  for (let i = MAX_ROTATED_FILES; i >= 1; i--) files.push(`${base}.${i}.jsonl`);
  files.push(`${base}.jsonl`);

  const out: PanicTelemetryEvent[] = [];
  for (const path of files) {
    if (!existsSync(path)) continue;
    let raw: string;
    try { raw = readFileSync(path, 'utf-8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t) as PanicTelemetryEvent); } catch { /* skip malformed */ }
    }
  }
  return out;
}

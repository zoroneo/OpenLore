/**
 * Personal token-value scorecard (Spec 25 Q2). Turns paired WITH/WITHOUT cells
 * into the honest "does it help on YOUR repo?" verdict — the same metrics the
 * README Value Scorecard publishes (cost + round-trips at equal correctness),
 * measured locally. Pure + deterministic.
 */

import type { Cell } from './measure.js';

export type Verdict = 'helps' | 'break-even' | "doesn't help here";

/**
 * How the scorecard's numbers were produced:
 * - `measured`  — a real WITH/WITHOUT agent pass (the `claude` arm).
 * - `estimate`  — a deterministic, graph-derived proxy (no agent, no API key).
 * - `dry-run`   — synthetic numbers from `--dry-run` (pipeline check only).
 * The mode travels with every serialized/rendered form so an estimate can never
 * be mistaken for a measured result (decision 66feae62).
 */
export type ProveMode = 'measured' | 'estimate' | 'dry-run';

/** Run-level provenance stamped onto a scorecard at command time. */
export interface ScorecardMeta {
  mode: ProveMode;
  /** ISO-8601 timestamp, stamped by the CLI (not the pure core). */
  generatedAt: string;
  /** Short repo SHA the run was measured against, or null if unavailable. */
  repoSha: string | null;
  /** Agent model for a measured/dry-run pass; null for an estimate. */
  model: string | null;
  /** Number of orientation tasks the scorecard covers. */
  tasks: number;
}

export interface Scorecard {
  costWithout: number;
  costWith: number;
  costDeltaPct: number;
  turnsWithout: number;
  turnsWith: number;
  turnsDeltaPct: number;
  correctWithout: number;
  correctWith: number;
  freshWithout: number;
  freshWith: number;
  runsPerArm: number;
  verdict: Verdict;
}

const pctDelta = (without: number, withv: number): number =>
  without === 0 ? 0 : Math.round(((withv - without) / without) * 100);

/**
 * Verdict rule, deliberately conservative and honest:
 * - if WITH is less correct than WITHOUT → "doesn't help here" (never trade accuracy)
 * - else if cost AND round-trips both improve by >5% → "helps"
 * - else if either regresses by >5% → "doesn't help here"
 * - otherwise → "break-even"
 */
export function verdict(sc: Omit<Scorecard, 'verdict'>): Verdict {
  if (sc.correctWith + 1e-9 < sc.correctWithout) return "doesn't help here";
  const cost = sc.costDeltaPct;
  const turns = sc.turnsDeltaPct;
  if (cost <= -5 && turns <= -5) return 'helps';
  if (cost >= 5 || turns >= 5) return "doesn't help here";
  return 'break-even';
}

export function computeScorecard(without: Cell, withCell: Cell): Scorecard {
  const base: Omit<Scorecard, 'verdict'> = {
    costWithout: without.costUsd,
    costWith: withCell.costUsd,
    costDeltaPct: pctDelta(without.costUsd, withCell.costUsd),
    turnsWithout: without.numTurns,
    turnsWith: withCell.numTurns,
    turnsDeltaPct: pctDelta(without.numTurns, withCell.numTurns),
    correctWithout: without.correctRate,
    correctWith: withCell.correctRate,
    freshWithout: without.freshInputTokens,
    freshWith: withCell.freshInputTokens,
    runsPerArm: Math.min(without.runs, withCell.runs),
  };
  return { ...base, verdict: verdict(base) };
}

const sign = (n: number): string => (n > 0 ? `+${n}` : `${n}`);
const pct = (r: number): string => `${Math.round(r * 100)}%`;

/**
 * Render the scorecard as a human-readable block for the terminal. `mode`
 * selects the banner and whether the noisy-sample caveat applies (it never does
 * for a deterministic `estimate`). Back-compat: `mock: true` still forces the
 * dry-run banner when `mode` is omitted.
 */
export function renderScorecard(sc: Scorecard, opts: { tasks: number; mock?: boolean; mode?: ProveMode }): string {
  const mode: ProveMode = opts.mode ?? (opts.mock ? 'dry-run' : 'measured');
  const lines: string[] = [];
  lines.push('');
  lines.push('  OpenLore — personal token-value scorecard');
  lines.push('  ' + '─'.repeat(48));
  if (mode === 'dry-run') {
    lines.push('  ⚠ DRY RUN — synthetic numbers, no agent was called. Run without --dry-run for real measurement.');
  } else if (mode === 'estimate') {
    lines.push('  ⚠ ESTIMATE — deterministic graph projection, NOT a measured agent run (no API key needed).');
    lines.push('    Run `openlore prove` (needs `claude` + API key) for a real WITH/WITHOUT measurement.');
  }
  lines.push(`  Tasks: ${opts.tasks}   Runs/arm: ${sc.runsPerArm}   (WITHOUT vs WITH openlore)`);
  lines.push('');
  lines.push(`  Cost          $${sc.costWithout.toFixed(3)}  →  $${sc.costWith.toFixed(3)}   (${sign(sc.costDeltaPct)}%)`);
  lines.push(`  Round-trips   ${sc.turnsWithout.toFixed(0)}  →  ${sc.turnsWith.toFixed(0)}   (${sign(sc.turnsDeltaPct)}%)`);
  lines.push(`  Fresh tokens  ${sc.freshWithout.toFixed(0)}  →  ${sc.freshWith.toFixed(0)}`);
  lines.push(`  Correctness   ${pct(sc.correctWithout)}  →  ${pct(sc.correctWith)}`);
  lines.push('');
  const verdictLabel =
    sc.verdict === 'helps' ? '✅ OpenLore helps on this repo'
      : sc.verdict === 'break-even' ? '➖ Break-even on this repo'
        : "❌ OpenLore doesn't help here";
  lines.push(`  Verdict: ${verdictLabel}`);
  // The small-sample caveat is about LLM noise — irrelevant to a deterministic estimate.
  if (mode !== 'estimate' && sc.runsPerArm < 3) {
    lines.push('  (sample is small — LLM runs are noisy; use --runs 4+ for a firmer number)');
  }
  lines.push('');
  return lines.join('\n');
}

// ── Machine-readable + shareable forms (Spec 25 / add-prove-shareable-scorecard) ──

/**
 * Stable, documented JSON shape for `openlore prove --json` — an external/CI
 * contract (decision 581a90bf). `schemaVersion` gates the format; new fields
 * append without a bump. The key set is asserted in tests so it cannot drift.
 */
export interface SerializedScorecard {
  schemaVersion: 1;
  mode: ProveMode;
  generatedAt: string;
  repo: { sha: string | null };
  model: string | null;
  runsPerArm: number;
  tasks: number;
  cost: { without: number; with: number; deltaPct: number };
  roundTrips: { without: number; with: number; deltaPct: number };
  freshTokens: { without: number; with: number };
  correctness: { without: number; with: number };
  verdict: Verdict;
}

/** Round to 4 decimals (sub-cent) so the JSON contract carries no float noise. */
const money = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Serialize a scorecard + run metadata into the stable `--json` shape. */
export function serializeScorecard(sc: Scorecard, meta: ScorecardMeta): SerializedScorecard {
  return {
    schemaVersion: 1,
    mode: meta.mode,
    generatedAt: meta.generatedAt,
    repo: { sha: meta.repoSha },
    model: meta.model,
    runsPerArm: sc.runsPerArm,
    tasks: meta.tasks,
    cost: { without: money(sc.costWithout), with: money(sc.costWith), deltaPct: sc.costDeltaPct },
    roundTrips: { without: sc.turnsWithout, with: sc.turnsWith, deltaPct: sc.turnsDeltaPct },
    freshTokens: { without: sc.freshWithout, with: sc.freshWith },
    correctness: { without: sc.correctWithout, with: sc.correctWith },
    verdict: sc.verdict,
  };
}

const verdictPhrase = (v: Verdict): string =>
  v === 'helps' ? 'helps on this repo'
    : v === 'break-even' ? 'break-even on this repo'
      : "doesn't help on this repo";

/** Banner that makes an estimate / dry-run impossible to read as a measured result. */
function modeBanner(mode: ProveMode): string | null {
  if (mode === 'estimate') {
    return '> **Estimate — not a measured agent run.** Deterministic, graph-derived projection of the ' +
      'orientation tax (no API key, no `claude`). Run `openlore prove` for a real WITH/WITHOUT measurement.';
  }
  if (mode === 'dry-run') {
    return '> **Dry run — synthetic numbers, no agent was called.** Run `openlore prove` without `--dry-run` for a real measurement.';
  }
  return null;
}

/**
 * Paste-ready markdown block matching the README Value Scorecard shape — wins and
 * losses both shown, honest verdict, plus a shields.io badge line a user can drop
 * into their own README. Same honest verdict as the terminal render.
 */
export function renderScorecardMarkdown(sc: Scorecard, meta: ScorecardMeta): string {
  const lines: string[] = [];
  lines.push('## OpenLore — token-value scorecard');
  lines.push('');
  const banner = modeBanner(meta.mode);
  if (banner) { lines.push(banner); lines.push(''); }
  const shaNote = meta.repoSha ? ` · repo \`${meta.repoSha}\`` : '';
  const modelNote = meta.model ? ` · model \`${meta.model}\`` : '';
  // "generated" is mode-neutral — an estimate is not "measured".
  lines.push(`_${meta.tasks} task(s) · ${sc.runsPerArm} run(s)/arm · generated ${meta.generatedAt}${shaNote}${modelNote}_`);
  lines.push('');
  lines.push('| Metric | WITHOUT | WITH | Δ |');
  lines.push('|---|---|---|---|');
  lines.push(`| Cost (USD) | $${sc.costWithout.toFixed(3)} | $${sc.costWith.toFixed(3)} | ${sign(sc.costDeltaPct)}% |`);
  lines.push(`| Round-trips | ${sc.turnsWithout.toFixed(0)} | ${sc.turnsWith.toFixed(0)} | ${sign(sc.turnsDeltaPct)}% |`);
  lines.push(`| Fresh tokens | ${sc.freshWithout.toFixed(0)} | ${sc.freshWith.toFixed(0)} | — |`);
  lines.push(`| Correctness | ${pct(sc.correctWithout)} | ${pct(sc.correctWith)} | — |`);
  lines.push('');
  const mark = sc.verdict === 'helps' ? '✅' : sc.verdict === 'break-even' ? '➖' : '❌';
  lines.push(`**Verdict: ${mark} OpenLore ${verdictPhrase(sc.verdict)}.**`);
  lines.push('');
  lines.push(scorecardBadgeMarkdown(sc, meta));
  lines.push('');
  return lines.join('\n');
}

/** shields.io colors keyed to the honest verdict. */
function verdictColor(v: Verdict): string {
  return v === 'helps' ? '2563eb' : v === 'break-even' ? '9ca3af' : 'ef4444';
}

/** Encode a shields.io static-badge label/message segment (`-` → `--`, space → `_`). */
function badgeSegment(s: string): string {
  return s.replace(/-/g, '--').replace(/_/g, '__').replace(/ /g, '_');
}

/**
 * shields.io static badge URL summarizing the run by its headline signal
 * (round-trips Δ — the most consistent, hardest-to-game metric). Estimate/dry-run
 * runs are labeled as such in the badge so a shared badge never overclaims.
 */
export function scorecardBadgeUrl(sc: Scorecard, meta: ScorecardMeta): string {
  const label = meta.mode === 'measured' ? 'OpenLore' : `OpenLore (${meta.mode})`;
  const msg = `round-trips ${sign(sc.turnsDeltaPct)}%`;
  return `https://img.shields.io/badge/${badgeSegment(label)}-${badgeSegment(msg)}-${verdictColor(sc.verdict)}`;
}

/** Markdown image for the badge (paste-ready). */
export function scorecardBadgeMarkdown(sc: Scorecard, meta: ScorecardMeta): string {
  return `![OpenLore token-value](${scorecardBadgeUrl(sc, meta)})`;
}

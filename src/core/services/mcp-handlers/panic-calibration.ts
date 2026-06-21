/**
 * Panic signal calibration — measure accuracy against a labeled ground-truth corpus.
 *
 * The observe-mode gate says the signal's accuracy must be proven by data. This is that proof, in
 * code: a corpus of behavioral traces each labeled with ground truth — 'coherent' (focused, healthy
 * work that must NOT trip an intervention) or 'confused' (thrashing/drift that SHOULD). Each trace is
 * replayed through the REAL engine (see panic-replay.ts) and scored. The result is a measured
 * false-positive rate and sensitivity (true-positive rate) over known-labeled behavior.
 *
 * This does not replace real observe-mode telemetry — it complements it: a deterministic, CI-runnable
 * baseline that fails loudly if a change to the engine degrades its discrimination. Contributors can
 * extend CALIBRATION_CORPUS with real recorded sessions (labeled by a human) to harden it further.
 *
 * The intervention threshold under test is L2 (the advisory-injection floor): a 'coherent' trace
 * tripping L2+ is a false positive; a 'confused' trace reaching L2+ is a true positive.
 */

import { replayBehavioralTrace, type ReplayStep } from './panic-replay.js';

export type GroundTruth = 'coherent' | 'confused';

export interface CalibrationScenario {
  name: string;
  label: GroundTruth;
  description: string;
  steps: ReplayStep[];
  sourceRoots?: string[];
}

// ── trace builders ────────────────────────────────────────────────────────────
const SEC = 1000;
const f = (mod: string, n: number) => `src/${mod}/file${n}.ts`;
/** N steps of a tool, each in `mod`, spaced `gapS` seconds apart. */
function inModule(tool: string, mod: string, n: number, gapS: number): ReplayStep[] {
  return Array.from({ length: n }, (_, i) => ({ tool, filePath: f(mod, i % 4), gapMs: gapS * SEC }));
}
/** N steps alternating between two modules (A→B→A→B…) — the confusion-loop shape. */
function oscillate(tool: string, a: string, b: string, n: number, gapS: number): ReplayStep[] {
  return Array.from({ length: n }, (_, i) => ({ tool, filePath: f(i % 2 === 0 ? a : b, i), gapMs: gapS * SEC }));
}
/** N steps each touching a distinct module from `mods`, cycling — cross-module thrash. */
function thrash(tool: string, mods: string[], n: number, gapS: number): ReplayStep[] {
  return Array.from({ length: n }, (_, i) => ({ tool, filePath: f(mods[i % mods.length], i), gapMs: gapS * SEC }));
}

// ── the labeled corpus ──────────────────────────────────────────────────────────
export const CALIBRATION_CORPUS: CalibrationScenario[] = [
  // ── coherent: healthy work that must NOT trip an intervention ──
  {
    name: 'focused-deep-work',
    label: 'coherent',
    description: 'Sustained work in a single module — many reads, steady pace.',
    steps: inModule('search_code', 'auth', 20, 20),
  },
  {
    name: 'focused-with-structural-reads',
    label: 'coherent',
    description: 'Deep work in one module mixing in heavier structural tools.',
    steps: [
      ...inModule('search_code', 'billing', 4, 15),
      ...inModule('get_function_body', 'billing', 6, 25),
      ...inModule('get_subgraph', 'billing', 3, 30),
    ],
  },
  {
    name: 'slow-paced-broad-reading',
    label: 'coherent',
    description: 'Occasional cross-module reads with long gaps — decay keeps it calm.',
    steps: [
      { tool: 'search_code', filePath: f('auth', 0), gapMs: 90 * SEC },
      { tool: 'search_code', filePath: f('billing', 0), gapMs: 120 * SEC },
      { tool: 'get_function_body', filePath: f('auth', 1), gapMs: 90 * SEC },
      { tool: 'search_code', filePath: f('auth', 2), gapMs: 60 * SEC },
    ],
  },
  {
    name: 'orient-then-focused',
    label: 'coherent',
    description: 'Orient, then a focused burst in one module — the intended healthy loop.',
    steps: [
      { tool: 'orient', gapMs: 0 },
      ...inModule('search_code', 'payments', 12, 18),
    ],
  },

  // ── confused: thrashing / drift that SHOULD trip an intervention ──
  {
    name: 'rapid-oscillation-loop',
    label: 'confused',
    description: 'Fast A↔B↔A↔B module ping-pong — the canonical confusion loop.',
    steps: oscillate('search_code', 'auth', 'billing', 16, 2),
  },
  {
    name: 'cross-module-thrash',
    label: 'confused',
    description: 'Rapid switching across many modules — high trajectory density.',
    steps: thrash('search_code', ['auth', 'billing', 'payments', 'orders', 'users', 'inventory'], 16, 3),
  },
  {
    name: 'heavy-tool-oscillation',
    label: 'confused',
    description: 'Architectural tracing while ping-ponging modules — load + drift.',
    steps: oscillate('trace_execution_path', 'auth', 'payments', 14, 4),
  },
];

/**
 * Known sensitivities — borderline traces where the signal is over/under-sensitive. These are NOT
 * asserted as "correct"; they are documented evidence (the gate must weigh them) and a regression
 * pin on current behavior, so any future engine change that shifts them is noticed. This is the
 * honest output of validating accuracy against data: where the signal is weak, in the open.
 */
export interface SensitivityScenario {
  name: string;
  description: string;
  /** Why the signal mis-judges this — the mechanism. */
  note: string;
  steps: ReplayStep[];
  sourceRoots?: string[];
  /** Whether this trace trips L2+ today (current, possibly-undesirable behavior). */
  trips_today: boolean;
}

export const KNOWN_SENSITIVITIES: SensitivityScenario[] = [
  {
    name: 'occasional-cross-check (over-sensitive)',
    description: 'Sustained work in one module with periodic brief checks elsewhere.',
    note:
      'The oscillation signal is dwell-insensitive: long runs in a base module collapse in the ' +
      'transition sequence, so "auth … (peek billing) … auth" reads as an A↔B confusion loop ' +
      '(oscillation ≈ 1.0) even though density stays low (~0.33). It trips today — a likely false ' +
      'positive. This is the kind of weakness that keeps intervention gated on real observe-mode ' +
      'validation rather than enabled by default.',
    steps: Array.from({ length: 20 }, (_, i) => ({
      tool: 'search_code',
      filePath: i % 5 === 4 ? `src/billing/file${i}.ts` : `src/auth/file${i % 3}.ts`,
      gapMs: 18 * SEC,
    })),
    trips_today: true,
  },
];

export interface ScenarioResult {
  name: string;
  label: GroundTruth;
  peakLevel: number;
  peakScore: number;
  trippedL2: boolean;
  /** Did the engine classify this trace the way its ground-truth label expects? */
  correct: boolean;
}

export interface CalibrationReport {
  scenarios: ScenarioResult[];
  coherent_total: number;
  false_positives: number;
  false_positive_rate: number;
  confused_total: number;
  true_positives: number;
  true_positive_rate: number;
  accuracy: number;
}

export interface SensitivityResult {
  name: string;
  description: string;
  note: string;
  peakLevel: number;
  trippedL2: boolean;
  /** true if current behavior still matches the documented expectation (regression pin). */
  matchesDocumented: boolean;
}

/** Evaluate the documented sensitivities against current engine behavior (regression pin). */
export function evaluateSensitivities(corpus: SensitivityScenario[] = KNOWN_SENSITIVITIES): SensitivityResult[] {
  return corpus.map((s) => {
    const r = replayBehavioralTrace(s.steps, { sourceRoots: s.sourceRoots });
    return {
      name: s.name,
      description: s.description,
      note: s.note,
      peakLevel: r.peakLevel,
      trippedL2: r.trippedL2,
      matchesDocumented: r.trippedL2 === s.trips_today,
    };
  });
}

/** Replay every scenario through the real engine and measure discrimination at the L2 threshold. */
export function computeCalibration(corpus: CalibrationScenario[] = CALIBRATION_CORPUS): CalibrationReport {
  const scenarios: ScenarioResult[] = corpus.map((s) => {
    const r = replayBehavioralTrace(s.steps, { sourceRoots: s.sourceRoots });
    const tripped = r.trippedL2;
    const correct = s.label === 'confused' ? tripped : !tripped;
    return { name: s.name, label: s.label, peakLevel: r.peakLevel, peakScore: r.peakScore, trippedL2: tripped, correct };
  });

  const coherent = scenarios.filter((s) => s.label === 'coherent');
  const confused = scenarios.filter((s) => s.label === 'confused');
  const falsePositives = coherent.filter((s) => s.trippedL2).length;
  const truePositives = confused.filter((s) => s.trippedL2).length;
  const correct = scenarios.filter((s) => s.correct).length;

  return {
    scenarios,
    coherent_total: coherent.length,
    false_positives: falsePositives,
    false_positive_rate: coherent.length ? falsePositives / coherent.length : 0,
    confused_total: confused.length,
    true_positives: truePositives,
    true_positive_rate: confused.length ? truePositives / confused.length : 0,
    accuracy: scenarios.length ? correct / scenarios.length : 0,
  };
}

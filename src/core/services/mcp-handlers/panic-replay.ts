/**
 * Deterministic panic replay — run the REAL behavioral engine over a recorded/synthetic trace.
 *
 * This is how the panic signal's accuracy is validated against data instead of asserted in code:
 * feed a sequence of (tool, filePath, time-gap) steps through the actual updateTracker /
 * updatePanic / resetPanicOnOrient pipeline an MCP session uses, with a virtual clock so the
 * time-based signals (decay, staleness, refractory) reproduce faithfully. Returns the panic
 * timeline and a summary (peak level, whether it tripped an intervention threshold).
 *
 * Used by the labeled-ground-truth calibration harness (CI) and the `openlore panic-replay`
 * command (real recorded sessions). No disk writes (directory is '' so emit() is a no-op).
 */

import {
  createTracker,
  updateTracker,
  updatePanic,
  resetPanicOnOrient,
  _setEngineClock,
  type EpistemicTracker,
} from './epistemic-lease.js';

export interface ReplayStep {
  /** Tool name (drives cognitive-load weight + the module window). */
  tool: string;
  /** File the tool acted on (drives module/density/oscillation). Omit for non-file tools. */
  filePath?: string;
  /** Milliseconds elapsed since the previous step (drives decay/staleness). Default 0. */
  gapMs?: number;
}

export interface ReplayTimelineEntry {
  i: number;
  tool: string;
  panicLevel: number;
  panicScore: number;
  freshnessState: string;
  staleDepth: number;
  density: number;
  oscillation: number;
}

export interface ReplayResult {
  steps: number;
  peakLevel: number;
  peakScore: number;
  /** true if any step reached L2+ (the advisory-intervention threshold). */
  trippedL2: boolean;
  finalLevel: number;
  finalState: string;
  timeline: ReplayTimelineEntry[];
}

/** Fixed virtual base time so replays are fully deterministic. */
const REPLAY_BASE_MS = 1_700_000_000_000;

/**
 * Replay a behavioral trace through the real engine. Deterministic: a virtual clock advances by
 * each step's gapMs, so the same trace always yields the same panic timeline.
 */
export function replayBehavioralTrace(
  steps: ReplayStep[],
  opts: { sourceRoots?: string[] } = {},
): ReplayResult {
  let now = REPLAY_BASE_MS;
  _setEngineClock(() => now);
  try {
    const tracker: EpistemicTracker = createTracker('');
    // No call-graph db in replay → set the source roots explicitly so module derivation works.
    tracker.sourceRoots = opts.sourceRoots ?? ['src'];

    const timeline: ReplayTimelineEntry[] = [];
    let peakLevel = 0;
    let peakScore = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      now += Math.max(0, typeof step.gapMs === 'number' && Number.isFinite(step.gapMs) ? step.gapMs : 0);

      // Defense in depth: only a string filePath reaches the engine (mirrors mcp.ts's guard).
      const filePath = typeof step.filePath === 'string' ? step.filePath : undefined;
      updateTracker(tracker, step.tool, '', filePath);
      if (step.tool === 'orient') {
        resetPanicOnOrient(tracker, '');
      } else {
        updatePanic(tracker, {
          density: tracker.density,
          oscillation: tracker.oscillation,
          weight: 1,
          staleDepth: tracker.staleDepth,
          directory: '',
          tool: step.tool,
        });
      }

      peakLevel = Math.max(peakLevel, tracker.panicLevel);
      peakScore = Math.max(peakScore, tracker.panicScore);
      timeline.push({
        i,
        tool: step.tool,
        panicLevel: tracker.panicLevel,
        panicScore: Math.round(tracker.panicScore),
        freshnessState: tracker.freshnessState,
        staleDepth: tracker.staleDepth,
        density: Math.round(tracker.density * 1000) / 1000,
        oscillation: Math.round(tracker.oscillation * 1000) / 1000,
      });
    }

    return {
      steps: steps.length,
      peakLevel,
      peakScore: Math.round(peakScore),
      trippedL2: peakLevel >= 2,
      finalLevel: tracker.panicLevel,
      finalState: tracker.freshnessState,
      timeline,
    };
  } finally {
    _setEngineClock(null); // always restore the real clock
  }
}

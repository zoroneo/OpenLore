/**
 * Observe-mode accuracy gate — validatePanicSignal() over synthetic panic telemetry.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validatePanicSignal, readPanicTelemetry, PANIC_GATE } from './panic-validation.js';
import type { PanicTelemetryEvent } from './panic-validation.js';

const ts = (offsetMs: number) => new Date(1_700_000_000_000 + offsetMs).toISOString();

const lc = (from: number, to: number, offsetMs: number): PanicTelemetryEvent =>
  ({ ts: ts(offsetMs), event: 'panic_level_change', from_level: from, to_level: to });
const sd = (offsetMs: number, triggers: Array<{ name: string; delta: number }>): PanicTelemetryEvent =>
  ({ ts: ts(offsetMs), event: 'panic_score_delta', triggers });
const orient = (offsetMs: number, delta = -40): PanicTelemetryEvent =>
  ({ ts: ts(offsetMs), event: 'panic_orient_reset', delta });
const hook = (offsetMs: number): PanicTelemetryEvent => ({ ts: ts(offsetMs), event: 'hook_intervention' });
const outcome = (offsetMs: number, lagMs = 3000): PanicTelemetryEvent =>
  ({ ts: ts(offsetMs), event: 'panic_intervention_outcome', outcome: 'responded', delta: lagMs });

/** One completed episode [start..end], optional in-window orient, peak level, and triggers. */
function episode(
  startMs: number,
  endMs: number,
  opts: { withOrient?: boolean; peak?: number; triggers?: string[] } = {},
): PanicTelemetryEvent[] {
  const peak = opts.peak ?? 2;
  const evs: PanicTelemetryEvent[] = [lc(0, peak, startMs)];
  if (opts.triggers?.length) evs.push(sd(startMs + 1, opts.triggers.map((name) => ({ name, delta: 15 }))));
  if (opts.withOrient) evs.push(orient(startMs + 2));
  evs.push(lc(peak, 0, endMs));
  return evs;
}

describe('validatePanicSignal — accuracy gate', () => {
  it('empty input → INSUFFICIENT_DATA, never CLEARED, all zero/null', () => {
    const r = validatePanicSignal([]);
    expect(r.verdict).toBe('INSUFFICIENT_DATA');
    expect(r.episodes).toEqual({ total: 0, completed: 0, open: 0 });
    expect(r.false_positive.proxy_rate).toBeNull();
    expect(r.intervention.follow_through_rate).toBeNull();
    expect(r.criteria.data_sufficient).toBe(false);
    expect(r.verdict).not.toBe('CLEARED'); // below the episode floor CLEARED is impossible
  });

  it('episode resolved via orient is not a false positive', () => {
    const r = validatePanicSignal(episode(0, 1000, { withOrient: true }));
    expect(r.false_positive.resolved_via_orient).toBe(1);
    expect(r.false_positive.resolved_via_decay).toBe(0);
    expect(r.false_positive.proxy_rate).toBe(0);
  });

  it('episode that returns to L0 without re-orient is a false-positive proxy', () => {
    const r = validatePanicSignal(episode(0, 1000, { withOrient: false }));
    expect(r.false_positive.resolved_via_decay).toBe(1);
    expect(r.false_positive.proxy_rate).toBe(1);
  });

  it('high-level (L3+) false positives are flagged separately', () => {
    const r = validatePanicSignal(episode(0, 1000, { withOrient: false, peak: 4 }));
    expect(r.peak_level_histogram.L4).toBe(1);
    expect(r.false_positive.high_level_count).toBe(1);
    expect(r.recommendations.some((s) => s.includes('peaked at L3+'))).toBe(true);
  });

  it('ignores triggers with no string name (malformed telemetry → no null/undefined trigger)', () => {
    const events: PanicTelemetryEvent[] = [
      lc(0, 2, 0),
      sd(1, [{ delta: 7 } as { name: string; delta: number }, { name: 'oscillation_spike', delta: 10 }]),
      lc(2, 0, 1000),
    ];
    const r = validatePanicSignal(events);
    const triggers = r.false_positive.by_trigger.map((t) => t.trigger);
    expect(triggers).toEqual(['oscillation_spike']);
    expect(triggers).not.toContain(null);
    expect(triggers).not.toContain(undefined);
  });

  it('attributes triggers to false-positive episodes', () => {
    const events = [
      ...episode(0, 1000, { withOrient: false, triggers: ['oscillation_spike'] }),     // FP
      ...episode(2000, 3000, { withOrient: true, triggers: ['oscillation_spike'] }),    // not FP
      ...episode(4000, 5000, { withOrient: false, triggers: ['oscillation_spike'] }),   // FP
      ...episode(6000, 7000, { withOrient: false, triggers: ['oscillation_spike'] }),   // FP
    ];
    const r = validatePanicSignal(events);
    const osc = r.false_positive.by_trigger.find((t) => t.trigger === 'oscillation_spike')!;
    expect(osc.all_episodes).toBe(4);
    expect(osc.fp_episodes).toBe(3);
    expect(osc.fp_share).toBeCloseTo(0.75);
    // ≥3 episodes and fp_share ≥ NOISY threshold → a "noisy trigger" recommendation
    expect(r.recommendations.some((s) => s.includes("'oscillation_spike' is noisy"))).toBe(true);
  });

  it('intervention follow-through = responded outcomes / hook intercepts, with avg lag', () => {
    const events = [...episode(0, 1000, { withOrient: true }), hook(100), hook(200), outcome(150, 4000)];
    const r = validatePanicSignal(events);
    expect(r.intervention.hook_intercepts).toBe(2);
    expect(r.intervention.responses).toBe(1);
    expect(r.intervention.follow_through_rate).toBe(0.5);
    expect(r.intervention.avg_response_lag_ms).toBe(4000);
  });

  it('counts recurrence when an episode re-opens within 60s of the prior end', () => {
    const events = [
      ...episode(0, 1000, { withOrient: true }),
      ...episode(1000 + 30_000, 1000 + 31_000, { withOrient: true }), // starts 30s after prev end
    ];
    const r = validatePanicSignal(events);
    expect(r.resolution.recurrence_count).toBe(1);
  });

  it('verdict flips to REVIEW_REQUIRED at the episode threshold but is never CLEARED', () => {
    const events: PanicTelemetryEvent[] = [];
    for (let i = 0; i < PANIC_GATE.MIN_EPISODES; i++) {
      events.push(...episode(i * 10_000, i * 10_000 + 1000, { withOrient: true }));
    }
    const r = validatePanicSignal(events);
    expect(r.episodes.completed).toBeGreaterThanOrEqual(PANIC_GATE.MIN_EPISODES);
    expect(r.verdict).toBe('REVIEW_REQUIRED');
    expect(r.criteria.data_sufficient).toBe(true);
    // All orient-resolved → fp ok; no intercepts → follow-through null; verdict still not CLEARED.
    expect(r.criteria.fp_ok).toBe(true);
    expect(['INSUFFICIENT_DATA', 'REVIEW_REQUIRED']).toContain(r.verdict);
  });

  it('emits CLEARED when every criterion meets target (data + low fp + good follow-through)', () => {
    const events: PanicTelemetryEvent[] = [];
    for (let i = 0; i < PANIC_GATE.MIN_EPISODES; i++) {
      events.push(...episode(i * 10_000, i * 10_000 + 1000, { withOrient: true }));
      events.push(hook(i * 10_000 + 3), outcome(i * 10_000 + 4));
    }
    const r = validatePanicSignal(events);
    expect(r.criteria.fp_ok).toBe(true);
    expect(r.criteria.follow_through_ok).toBe(true);
    expect(r.criteria.data_sufficient).toBe(true);
    expect(r.verdict).toBe('CLEARED'); // mechanical read of the criteria — does not activate anything
    expect(r.recommendations.some((s) => s.includes('Gate CLEARED'))).toBe(true);
  });

  it('does NOT clear when follow-through is unmeasured (pure observe mode, no interventions)', () => {
    // Data sufficient + fp ok, but no hook intercepts → follow-through null → not affirmatively met.
    const events: PanicTelemetryEvent[] = [];
    for (let i = 0; i < PANIC_GATE.MIN_EPISODES; i++) {
      events.push(...episode(i * 10_000, i * 10_000 + 1000, { withOrient: true }));
    }
    const r = validatePanicSignal(events);
    expect(r.criteria.follow_through_ok).toBeNull();
    expect(r.verdict).toBe('REVIEW_REQUIRED');
  });

  it('flags a high false-positive proxy as blocking', () => {
    const events: PanicTelemetryEvent[] = [];
    for (let i = 0; i < PANIC_GATE.MIN_EPISODES; i++) {
      events.push(...episode(i * 10_000, i * 10_000 + 1000, { withOrient: false })); // all decay → fp 100%
    }
    const r = validatePanicSignal(events);
    expect(r.false_positive.proxy_rate).toBe(1);
    expect(r.criteria.fp_ok).toBe(false);
    expect(r.recommendations.some((s) => s.includes('exceeds the 20% target'))).toBe(true);
  });
});

// ============================================================================
// readPanicTelemetry — spans the live file AND rotated archives (episode floor reachable)
// ============================================================================

describe('readPanicTelemetry', () => {
  let dir: string;
  let tel: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-panictel-'));
    tel = join(dir, '.openlore', 'telemetry');
    mkdirSync(tel, { recursive: true });
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const writeJsonl = (name: string, events: PanicTelemetryEvent[]): void =>
    writeFileSync(join(tel, name), events.map((e) => JSON.stringify(e)).join('\n') + '\n');

  it('returns [] when nothing has been written', () => {
    expect(readPanicTelemetry(dir)).toEqual([]);
  });

  it('reads only the live file when no archives exist', () => {
    writeJsonl('panic.jsonl', [{ ts: '2026-01-01T00:00:00Z', event: 'hook_intervention' }]);
    expect(readPanicTelemetry(dir)).toHaveLength(1);
  });

  it('spans live + rotated archives so rotated episodes are not discarded', () => {
    // Rotation shifts live→.1→.2…; the gate must still see all of them.
    writeJsonl('panic.2.jsonl', [{ ts: '2026-01-01T00:00:00Z', event: 'panic_level_change', from_level: 0, to_level: 2 }]);
    writeJsonl('panic.1.jsonl', [{ ts: '2026-01-01T00:00:01Z', event: 'panic_level_change', from_level: 2, to_level: 0 }]);
    writeJsonl('panic.jsonl', [{ ts: '2026-01-01T00:00:02Z', event: 'hook_intervention' }]);
    const events = readPanicTelemetry(dir);
    expect(events).toHaveLength(3);
    // A completed episode lives entirely in the rotated archives — the gate must count it.
    const report = validatePanicSignal(events);
    expect(report.episodes.completed).toBe(1);
  });

  it('makes the MIN_EPISODES floor reachable across rotation (episodes split over archives)', () => {
    // Half the completed episodes in an archive, half live — neither file alone meets the floor.
    const half = Math.ceil(PANIC_GATE.MIN_EPISODES / 2);
    const ep = (i: number): PanicTelemetryEvent[] => ([
      { ts: new Date(1_700_000_000_000 + i * 10_000).toISOString(), event: 'panic_level_change', from_level: 0, to_level: 2 },
      { ts: new Date(1_700_000_000_000 + i * 10_000 + 1000).toISOString(), event: 'panic_level_change', from_level: 2, to_level: 0 },
    ]);
    const archived: PanicTelemetryEvent[] = [];
    const live: PanicTelemetryEvent[] = [];
    for (let i = 0; i < half; i++) archived.push(...ep(i));
    for (let i = half; i < PANIC_GATE.MIN_EPISODES; i++) live.push(...ep(i));
    writeJsonl('panic.1.jsonl', archived);
    writeJsonl('panic.jsonl', live);
    const report = validatePanicSignal(readPanicTelemetry(dir));
    expect(report.episodes.completed).toBeGreaterThanOrEqual(PANIC_GATE.MIN_EPISODES);
    expect(report.criteria.data_sufficient).toBe(true);
  });

  it('skips malformed lines and never throws', () => {
    writeFileSync(join(tel, 'panic.jsonl'), '{bad\n{"ts":"2026-01-01T00:00:00Z","event":"hook_intervention"}\n\n');
    expect(() => readPanicTelemetry(dir)).not.toThrow();
    expect(readPanicTelemetry(dir)).toHaveLength(1);
  });
});

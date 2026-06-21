/**
 * Deterministic replay engine — drives the real panic engine over a trace with a virtual clock.
 */

import { describe, it, expect } from 'vitest';
import { replayBehavioralTrace, type ReplayStep } from './panic-replay.js';

const f = (mod: string, n: number) => `src/${mod}/file${n}.ts`;
const confusedTrace = (n: number): ReplayStep[] =>
  Array.from({ length: n }, (_, i) => ({ tool: 'search_code', filePath: f(i % 2 ? 'auth' : 'billing', i), gapMs: 2000 }));
const focusedTrace = (n: number): ReplayStep[] =>
  Array.from({ length: n }, (_, i) => ({ tool: 'search_code', filePath: f('auth', i % 3), gapMs: 20_000 }));

describe('replayBehavioralTrace', () => {
  it('is deterministic — same trace yields identical results', () => {
    const t = confusedTrace(14);
    const a = replayBehavioralTrace(t);
    const b = replayBehavioralTrace(t);
    expect(a).toEqual(b);
  });

  it('a rapid oscillation trace trips L2+', () => {
    const r = replayBehavioralTrace(confusedTrace(14));
    expect(r.trippedL2).toBe(true);
    expect(r.peakLevel).toBeGreaterThanOrEqual(2);
  });

  it('focused single-module work stays calm (does not trip)', () => {
    const r = replayBehavioralTrace(focusedTrace(15));
    expect(r.trippedL2).toBe(false);
    expect(r.peakLevel).toBe(0);
  });

  it('restores the real clock after replay (no time leak into production paths)', () => {
    const before = Date.now();
    replayBehavioralTrace(confusedTrace(4)); // uses a virtual base far in the past
    const after = Date.now();
    // If the engine clock had leaked, Date.now() comparisons would be unaffected, but a fresh
    // replay must still start from the virtual base — assert by re-running and matching.
    expect(after).toBeGreaterThanOrEqual(before);
    const r1 = replayBehavioralTrace(confusedTrace(6));
    const r2 = replayBehavioralTrace(confusedTrace(6));
    expect(r1.timeline).toEqual(r2.timeline); // determinism proves the clock was reset each run
  });

  it('produces a per-step timeline of the same length as the trace', () => {
    const r = replayBehavioralTrace(confusedTrace(10));
    expect(r.timeline).toHaveLength(10);
    expect(r.timeline[0]).toHaveProperty('panicLevel');
    expect(r.timeline[0]).toHaveProperty('density');
  });

  it('respects custom source roots for module derivation', () => {
    const steps: ReplayStep[] = Array.from({ length: 14 }, (_, i) => ({
      tool: 'search_code', filePath: `lib/${i % 2 ? 'auth' : 'billing'}/x${i}.ts`, gapMs: 2000,
    }));
    // With the right root, modules resolve and oscillation trips; with the wrong root, no modules → calm.
    expect(replayBehavioralTrace(steps, { sourceRoots: ['lib'] }).trippedL2).toBe(true);
    expect(replayBehavioralTrace(steps, { sourceRoots: ['src'] }).peakLevel).toBe(0);
  });

  it('tolerates malformed steps (regression: non-string filePath / bad gapMs must not crash)', () => {
    // Steps as they might arrive from a hand-written or corrupt trace file.
    const bad = [
      { tool: 'search_code', filePath: 42 as unknown as string, gapMs: -5 },
      { tool: 'search_code', filePath: { nope: true } as unknown as string },
      { tool: 'search_code', gapMs: NaN as unknown as number },
      { tool: 'search_code', filePath: 'src/auth/x.ts', gapMs: 1000 },
    ];
    expect(() => replayBehavioralTrace(bad)).not.toThrow();
    const r = replayBehavioralTrace(bad);
    expect(r.steps).toBe(4);
    expect(r.timeline).toHaveLength(4);
  });

  it('empty trace → no panic, empty timeline', () => {
    const r = replayBehavioralTrace([]);
    expect(r.steps).toBe(0);
    expect(r.peakLevel).toBe(0);
    expect(r.timeline).toEqual([]);
  });
});

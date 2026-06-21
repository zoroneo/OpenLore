/**
 * Panic signal accuracy — measured against the labeled ground-truth corpus.
 *
 * This is the CI guard on the signal's discrimination: if a change to the engine causes a coherent
 * trace to trip an intervention (false positive) or a confused trace to stop tripping (lost
 * sensitivity), this fails. It is the in-code half of "accuracy proven by data".
 */

import { describe, it, expect } from 'vitest';
import {
  computeCalibration,
  evaluateSensitivities,
  CALIBRATION_CORPUS,
  KNOWN_SENSITIVITIES,
} from './panic-calibration.js';

describe('panic signal calibration (labeled ground truth)', () => {
  const report = computeCalibration();

  it('produces ZERO false positives — no coherent trace trips an intervention', () => {
    const fps = report.scenarios.filter((s) => s.label === 'coherent' && s.trippedL2);
    expect(fps, `false positives: ${fps.map((s) => s.name).join(', ')}`).toHaveLength(0);
    expect(report.false_positive_rate).toBe(0);
  });

  it('has full sensitivity — every confused trace trips an intervention', () => {
    const misses = report.scenarios.filter((s) => s.label === 'confused' && !s.trippedL2);
    expect(misses, `missed: ${misses.map((s) => s.name).join(', ')}`).toHaveLength(0);
    expect(report.true_positive_rate).toBe(1);
  });

  it('classifies every labeled scenario correctly (100% accuracy on the clear-cut corpus)', () => {
    expect(report.accuracy).toBe(1);
    for (const s of report.scenarios) expect(s.correct, `${s.name} misclassified`).toBe(true);
  });

  it('covers both healthy and unhealthy behavior (corpus is balanced)', () => {
    expect(report.coherent_total).toBeGreaterThanOrEqual(3);
    expect(report.confused_total).toBeGreaterThanOrEqual(3);
    expect(CALIBRATION_CORPUS.length).toBe(report.scenarios.length);
  });
});

describe('panic signal — documented known sensitivities (regression pins)', () => {
  it('current behavior still matches every documented sensitivity', () => {
    const results = evaluateSensitivities();
    for (const r of results) {
      // A failure here means the engine's behavior on a documented weak spot CHANGED — re-evaluate
      // the note (it may now be fixed, or newly broken). Intentional, not a silent pass.
      expect(r.matchesDocumented, `${r.name} no longer matches its documented behavior`).toBe(true);
    }
    expect(results).toHaveLength(KNOWN_SENSITIVITIES.length);
  });

  it('documents the dwell-insensitive oscillation over-sensitivity', () => {
    const occ = evaluateSensitivities().find((s) => s.name.startsWith('occasional-cross-check'));
    expect(occ).toBeDefined();
    expect(occ!.trippedL2).toBe(true); // it over-fires today — the gate must weigh this
  });
});

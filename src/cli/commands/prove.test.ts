/**
 * Tests for the prove command's persistence + result plumbing
 * (add-prove-shareable-scorecard). The deterministic agent-eval core is covered
 * in src/core/agent-eval/agent-eval.test.ts; here we exercise saveScorecard's
 * filesystem behavior (dated, non-clobbering) against a real temp dir.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveScorecard, parseNumericFlag, type ProveResult } from './prove.js';
import { OPENLORE_PROVE_REL_PATH } from '../../constants.js';
import type { Scorecard, ScorecardMeta } from '../../core/agent-eval/scorecard.js';

const scorecard: Scorecard = {
  costWithout: 0.2, costWith: 0.16, costDeltaPct: -20,
  turnsWithout: 20, turnsWith: 14, turnsDeltaPct: -30,
  correctWithout: 1, correctWith: 1, freshWithout: 13000, freshWith: 4000,
  samplesPerArm: 1, verdict: 'helps',
};
const baseMeta: ScorecardMeta = {
  mode: 'estimate', generatedAt: '2026-06-22T10:00:00.000Z', repoSha: 'abc1234', model: null, tasks: 3,
};
const result = (meta: ScorecardMeta = baseMeta): ProveResult => ({
  ok: true,
  message: 'rendered',
  scorecard,
  meta,
  raw: { withoutCell: { costUsd: 0.2, freshInputTokens: 13000, cacheReadTokens: 0, numTurns: 20, durationMs: 0, correctRate: 1, runs: 1 },
    withCell: { costUsd: 0.16, freshInputTokens: 4000, cacheReadTokens: 0, numTurns: 14, durationMs: 0, correctRate: 1, runs: 1 } },
});

describe('saveScorecard', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'openlore-prove-test-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('writes a dated file under .openlore/prove/ with the serialized scorecard + raw', () => {
    const path = saveScorecard(dir, result());
    expect(path).toContain(join(OPENLORE_PROVE_REL_PATH, 'prove-2026-06-22.json'));
    expect(existsSync(path)).toBe(true);
    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.mode).toBe('estimate');
    expect(saved.roundTrips).toEqual({ without: 20, with: 14, deltaPct: -30 });
    expect(saved.raw).toBeTruthy(); // raw metrics persisted for diffing
  });

  it('does not clobber a same-day run — it adds a numeric suffix', () => {
    const p1 = saveScorecard(dir, result());
    const p2 = saveScorecard(dir, result());
    const p3 = saveScorecard(dir, result());
    expect(p1).not.toBe(p2);
    expect(p2).not.toBe(p3);
    const files = readdirSync(join(dir, OPENLORE_PROVE_REL_PATH)).sort();
    expect(files).toEqual(['prove-2026-06-22-2.json', 'prove-2026-06-22-3.json', 'prove-2026-06-22.json']);
  });

  it('separates runs from different days into different files', () => {
    saveScorecard(dir, result());
    saveScorecard(dir, result({ ...baseMeta, generatedAt: '2026-06-23T09:00:00.000Z' }));
    const files = readdirSync(join(dir, OPENLORE_PROVE_REL_PATH)).sort();
    expect(files).toEqual(['prove-2026-06-22.json', 'prove-2026-06-23.json']);
  });

  it('rounds float noise out of the persisted raw block', () => {
    const noisy = result();
    noisy.raw!.withoutCell.costUsd = 0.057999999999999996;
    noisy.raw!.withCell.costUsd = 0.043000000000000003;
    const saved = JSON.parse(readFileSync(saveScorecard(dir, noisy), 'utf-8'));
    expect(saved.raw.withoutCell.costUsd).toBe(0.058);
    expect(saved.raw.withCell.costUsd).toBe(0.043);
  });
});

describe('parseNumericFlag', () => {
  it('returns the default when the flag is absent', () => {
    expect(parseNumericFlag(undefined, 'runs', true, 1, 2)).toBe(2);
  });
  it('parses and clamps a valid value to the minimum', () => {
    expect(parseNumericFlag('4', 'runs', true, 1, 2)).toBe(4);
    expect(parseNumericFlag('0', 'runs', true, 1, 2)).toBe(1);   // clamp up
    expect(parseNumericFlag('-3', 'runs', true, 1, 2)).toBe(1);  // clamp up
    expect(parseNumericFlag('1.9', 'runs', true, 1, 2)).toBe(1); // int truncation
    expect(parseNumericFlag('0.5', 'max-budget-usd', false, 0, 0.5)).toBe(0.5);
  });
  it('REJECTS a non-numeric value instead of letting NaN through', () => {
    const r = parseNumericFlag('abc', 'runs', true, 1, 2);
    expect(typeof r).toBe('object');
    expect((r as { error: string }).error).toContain('--runs must be a number');
    const b = parseNumericFlag('xyz', 'max-budget-usd', false, 0, 0.5);
    expect((b as { error: string }).error).toContain('--max-budget-usd must be a number');
  });
});

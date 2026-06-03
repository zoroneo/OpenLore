/**
 * Spec 25 — honesty-contract enforcement (the guard the contract asks for).
 *
 * The README Value Scorecard, the orient skill, and the install template make
 * public cost/token claims. This test makes the honesty contract executable
 * rather than aspirational:
 *   1. Every figure published in the README scorecard must match the canonical
 *      measured values below (sourced from docs/AGENT-BENCHMARKS.md). Re-measure
 *      → update BOTH the doc and these constants in the same reviewed change.
 *   2. The retired unproven estimates must never reappear in any shipped surface.
 *
 * If you change a published number without updating CANONICAL (or you let an
 * unmeasured estimate back in), this test fails — by design.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf-8');

/** The measured numbers the README is allowed to publish (docs/AGENT-BENCHMARKS.md). */
const CANONICAL = {
  measuredDate: '2026-06-01',       // Round 2 (N=4) headline measurement
  reproveDate: '2026-06-03',        // Round 3 live re-prove (N=2)
  aggregateRoundTripsDelta: '26%',  // −26% round-trips, the co-headline
  smallRepoCostDelta: '43%',        // +43% on small/familiar repos (Round 1 published loss)
  deepCostRange: ['7%', '21%'],     // −7%→−21% on deep traces
  perRepo: ['25 → 16', '17 → 13', '13 → 11', '21 → 15', '10 → 9'], // round-trips wo→w
  // Round 3 (2026-06-03, N=2): deep win reproduced + small-repo task-dependence.
  round3: ['13%', '32%', '59%'],
};

/** Estimates retired in Spec 25 Phase A — must not reappear in shipped surfaces. */
const BANNED = ['15,000', '50,000', 'replaces 10+ file reads', '1–3k vs 15'];

describe('honesty contract (spec-25)', () => {
  const readme = read('README.md');

  it('README contains a Value Scorecard section', () => {
    expect(readme).toContain('## Value Scorecard');
  });

  it('every canonical measured figure appears in the README', () => {
    expect(readme).toContain(CANONICAL.measuredDate);
    expect(readme).toContain(CANONICAL.reproveDate);
    expect(readme).toContain(CANONICAL.aggregateRoundTripsDelta);
    expect(readme).toContain(CANONICAL.smallRepoCostDelta);
    for (const r of CANONICAL.deepCostRange) expect(readme).toContain(r);
    for (const cell of CANONICAL.perRepo) expect(readme, `missing per-repo round-trips "${cell}"`).toContain(cell);
    for (const r of CANONICAL.round3) expect(readme, `missing Round-3 figure "${r}"`).toContain(r);
  });

  it('publishes the loss cell next to the wins (never hides +43%)', () => {
    // The scorecard must mention both an improvement and the regression.
    expect(readme).toContain(CANONICAL.smallRepoCostDelta);
    expect(readme.toLowerCase()).toMatch(/adds overhead|don't use it here|doesn't help/);
  });

  it('no retired unproven estimate appears in README, skill, or install template', () => {
    const surfaces: Array<[string, string]> = [
      ['README.md', readme],
      ['skills/openlore-orient/SKILL.md', read('skills/openlore-orient/SKILL.md')],
      ['src/cli/install/templates/agent-instructions.md', read('src/cli/install/templates/agent-instructions.md')],
    ];
    for (const [name, text] of surfaces) {
      for (const banned of BANNED) {
        expect(text.includes(banned), `"${banned}" must not appear in ${name}`).toBe(false);
      }
    }
  });

  it('the honesty contract is written into the benchmark doc', () => {
    expect(read('docs/AGENT-BENCHMARKS.md')).toContain('Honesty contract');
  });
});

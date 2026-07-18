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
import { TOOL_PRESETS, BREADTH_POINTER } from './cli/commands/mcp.js';
import { LEAN_DEFAULT_PRESET } from './constants.js';

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

/**
 * mcp-quality — DefaultSurfaceCopyMatchesItsContents (change: reconcile-substrate-write-face).
 *
 * The default `substrate` preset holds the navigation core plus governance *reads*
 * (recall, verify_claim, blast_radius); it carries the READ face, not the write face
 * (remember, record_decision). "Both faces of the substrate" is therefore an over-claim
 * — the same defect class as a tool implying completeness it lacks (NoFalseCompleteness),
 * located in the most-read copy surface (the `instructions` breadth pointer). This guard
 * bans that phrasing across every shipped surface WHILE the preset lacks the write face,
 * so the retired claim cannot silently rot back in. When step 2 lands the write face
 * (benchmark-gated, ADR-0023 process), `hasWriteFace` flips true and the ban lifts on its
 * own — the copy would then be truthful.
 */
describe('default-surface copy matches its contents (mcp-quality: DefaultSurfaceCopyMatchesItsContents)', () => {
  const substrate = TOOL_PRESETS[LEAN_DEFAULT_PRESET];
  const hasWriteFace = substrate.has('remember') && substrate.has('record_decision');

  // The over-claim: "both faces" / "both-faced" describing the reads-only default. Matched
  // case-insensitively with a space or hyphen so "both-faced" and "both faces" both trip it.
  const OVER_CLAIM = /both[ -]faces?|both-faced/i;

  // Every shipped surface that describes the default preset. The `--preset` help lives in
  // mcp.ts as a single-line commander option; the breadth pointer is imported directly.
  const DOC_SURFACES = [
    'README.md',
    'CLAUDE.md',
    'docs/install.md',
    'docs/agent-setup.md',
    'docs/cli-reference.md',
    'docs/mcp-tools.md',
  ];

  it('the substrate default holds governance reads only (guard premise)', () => {
    // If this fails, the write face landed — update the copy AND lift the ban below.
    expect(substrate.has('recall')).toBe(true);
    expect(hasWriteFace).toBe(false);
  });

  it('no shipped doc surface claims "both faces" while the preset is reads-only', () => {
    if (hasWriteFace) return; // write face landed → the claim would be truthful; ban lifts.
    for (const rel of DOC_SURFACES) {
      const text = read(rel);
      expect(OVER_CLAIM.test(text), `"both faces" over-claim must not appear in ${rel} while the substrate preset lacks the write face`).toBe(false);
    }
  });

  it('the instructions breadth pointer does not claim "both faces"', () => {
    if (hasWriteFace) return;
    expect(OVER_CLAIM.test(BREADTH_POINTER), `BREADTH_POINTER must not claim "both faces" while the substrate preset lacks the write face:\n${BREADTH_POINTER}`).toBe(false);
    // Positive: it names what the preset actually carries.
    expect(BREADTH_POINTER.toLowerCase()).toContain('governance reads');
  });

  it('the --preset help does not claim "both faces" and names the substrate default', () => {
    if (hasWriteFace) return;
    const mcpSrc = read('src/cli/commands/mcp.ts');
    const helpLine = mcpSrc.split('\n').find(l => l.includes(".option('--preset <name>'"));
    expect(helpLine, "expected a .option('--preset <name>', ...) line in mcp.ts").toBeDefined();
    expect(OVER_CLAIM.test(helpLine!), `the --preset help must not claim "both faces" while the substrate preset lacks the write face:\n${helpLine}`).toBe(false);
    // The declared default is interpolated from LEAN_DEFAULT_PRESET (the single source of
    // truth the code resolves through), not a hardcoded preset name that could drift.
    expect(helpLine!).toContain('${LEAN_DEFAULT_PRESET}');
  });
});

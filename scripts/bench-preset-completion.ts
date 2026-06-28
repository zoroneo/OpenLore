/**
 * Preset task-COMPLETION benchmark — phase 1 of the rigorous DefaultSurfaceRevealsAllFaces
 * validation (change: refine-happy-path-and-defaults).
 *
 * `bench-preset-selection.ts` measured first-tool SELECTION on a hand-authored corpus.
 * This measures the thing the default actually affects: END-TO-END TASK COMPLETION under
 * `navigation` vs `substrate`, on pinned real repos, scored by an INDEPENDENT oracle.
 *
 * It does not reimplement the agent loop — it drives the existing `bench-agent.ts`
 * (clone @ SHA → analyze → run headless `claude` → score by `expect.mustInclude` →
 * metrics) once per preset via its `--with-only --results-json` hook, then compares the
 * two WITH arms per repo TIER and applies a PRE-REGISTERED decision rule. Reusing that
 * harness means the corpus, oracle, isolation (`--strict-mcp-config`) and metrics are
 * the audited ones, not a second implementation.
 *
 * Pre-registered decision rule (fixed BEFORE looking at results):
 *   FLIP the default to `substrate` iff, on EVERY tier, substrate's correctness is not
 *   worse than navigation's by more than NOISE_MARGIN, AND substrate's median cost is
 *   within COST_TOLERANCE of navigation's. Otherwise HOLD.
 *
 * Setup runs ONCE (clone+analyze) and is reused across both presets (same index; only
 * the wired MCP preset differs). Uses the Claude Code CLI — subscription auth, no API key.
 *
 * Run:  npx tsx scripts/bench-preset-completion.ts [--runs N] [--model sonnet|opus]
 *                                                  [--repos a,b] [--tasks x,y]
 *                                                  [--dry-run] [--skip-setup] [--json]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { REPOS } from './bench-agent.tasks.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH_AGENT = join(__dirname, 'bench-agent.ts');

// ── Pre-registered decision rule (do not tune after seeing results) ──────────
const NOISE_MARGIN = 0.05;    // substrate may trail navigation by at most 5pp correctness on any tier
const COST_TOLERANCE = 0.20;  // substrate median cost may exceed navigation's by at most 20%

const PRESETS = ['navigation', 'substrate'] as const;
type Preset = (typeof PRESETS)[number];
type Tier = 'small-familiar' | 'large-unfamiliar';

interface Cell { costUsd: number; correctRate: number; n: number; freshInputTokens: number; cacheReadTokens: number }
interface TaskResult { taskId: string; repo: string; tier: Tier; with: Cell }
interface AgentResults { perTask: TaskResult[] }

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const hasFlag = (f: string): boolean => process.argv.includes(f);

function runArm(preset: Preset, work: string, resultsPath: string, firstArm: boolean): AgentResults {
  const args = [
    BENCH_AGENT,
    '--with-only',
    '--with-preset', preset,
    '--results-json', resultsPath,
    '--out', join(work, `report-${preset}.md`),
    '--work', work,
    '--runs', arg('--runs', '3')!,
    '--model', arg('--model', 'sonnet')!,
    '--max-budget-usd', arg('--max-budget-usd', '2')!,
  ];
  if (arg('--repos')) args.push('--repos', arg('--repos')!);
  if (arg('--tasks')) args.push('--tasks', arg('--tasks')!);
  if (hasFlag('--dry-run')) args.push('--dry-run');
  // Setup (clone + analyze) runs only for the FIRST arm; the second reuses the same
  // work dir + index. A caller-supplied --skip-setup forces reuse for both.
  if (hasFlag('--skip-setup') || !firstArm) args.push('--skip-setup');

  execFileSync('npx', ['tsx', ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
  return JSON.parse(readFileSync(resultsPath, 'utf-8')) as AgentResults;
}

const TIERS: Tier[] = ['small-familiar', 'large-unfamiliar'];

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface TierAgg { tier: Tier; tasks: number; correctness: number; costUsd: number }
function aggregate(results: AgentResults): Record<Tier, TierAgg> {
  const out = {} as Record<Tier, TierAgg>;
  for (const tier of TIERS) {
    const cells = results.perTask.filter((t) => t.tier === tier).map((t) => t.with);
    out[tier] = {
      tier,
      tasks: cells.length,
      correctness: mean(cells.map((c) => c.correctRate)),
      costUsd: median(cells.map((c) => c.costUsd)),
    };
  }
  return out;
}

function pctOrDash(n: number): string { return Number.isFinite(n) ? `${Math.round(n * 100)}%` : '—'; }

function main(): void {
  const work = arg('--work', join(tmpdir(), 'openlore-bench-preset-completion'))!;
  mkdirSync(work, { recursive: true });
  const json = hasFlag('--json');

  if (!hasFlag('--dry-run')) {
    console.error('[bench-preset-completion] LIVE run — clones repos and makes real agent calls (Claude Code CLI). Ctrl-C to abort.');
  }

  const byPreset: Record<Preset, AgentResults> = {} as Record<Preset, AgentResults>;
  PRESETS.forEach((preset, idx) => {
    console.error(`\n[bench-preset-completion] === arm: ${preset} ===`);
    byPreset[preset] = runArm(preset, work, join(work, `results-${preset}.json`), idx === 0);
  });

  const aggNav = aggregate(byPreset.navigation);
  const aggSub = aggregate(byPreset.substrate);

  // Apply the pre-registered rule.
  const perTier = TIERS.map((tier) => {
    const nav = aggNav[tier], sub = aggSub[tier];
    const correctnessRegression = sub.tasks > 0 && nav.tasks > 0 && sub.correctness < nav.correctness - NOISE_MARGIN;
    const costDelta = nav.costUsd > 0 ? sub.costUsd / nav.costUsd - 1 : 0;
    const costOver = costDelta > COST_TOLERANCE;
    return { tier, nav, sub, correctnessRegression, costDelta, costOver };
  });
  const anyRegression = perTier.some((t) => t.correctnessRegression);
  const anyCostOver = perTier.some((t) => t.costOver);
  const flipCleared = !anyRegression && !anyCostOver;

  const summary = {
    rule: { noiseMargin: NOISE_MARGIN, costTolerance: COST_TOLERANCE },
    perTier,
    anyRegression,
    anyCostOver,
    flipCleared,
    note: hasFlag('--dry-run') ? 'DRY RUN — synthetic mock numbers, not decision-grade' : undefined,
  };

  // Persist the evidence (gitignored dir; the report numbers go in the change docs).
  try {
    const dir = join(process.cwd(), '.openlore', 'bench');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'preset-completion.json'), JSON.stringify({ byPreset, summary }, null, 2));
  } catch { /* non-fatal */ }

  if (json) { process.stdout.write(JSON.stringify(summary, null, 2) + '\n'); return; }

  const L: string[] = ['', 'Task-completion comparison — navigation vs substrate (end-to-end, oracle-scored):', ''];
  L.push('  tier              tasks   correctness(nav→sub)    median cost(nav→sub)   Δcost');
  L.push('  ' + '-'.repeat(78));
  for (const t of perTier) {
    L.push('  ' + t.tier.padEnd(18) + String(t.sub.tasks).padStart(3) + '     ' +
      `${pctOrDash(t.nav.correctness)} → ${pctOrDash(t.sub.correctness)}`.padEnd(22) +
      `$${t.nav.costUsd.toFixed(3)} → $${t.sub.costUsd.toFixed(3)}`.padEnd(22) +
      `${t.costDelta >= 0 ? '+' : ''}${Math.round(t.costDelta * 100)}%` +
      (t.correctnessRegression ? '  ⚠ REGRESSION' : '') + (t.costOver ? '  ⚠ COST' : ''));
  }
  L.push('');
  L.push(`  Pre-registered rule: flip iff (no tier correctness regression > ${NOISE_MARGIN * 100}pp) AND (median cost ≤ +${COST_TOLERANCE * 100}%).`);
  L.push(`  Verdict: ${hasFlag('--dry-run') ? 'DRY RUN (synthetic)' : flipCleared ? 'FLIP CLEARED' : 'HOLD'}.`);
  L.push('');
  process.stdout.write(L.join('\n') + '\n');
}

main();

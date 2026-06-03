/**
 * Spec 14 — Agent Token-Efficiency Benchmark Harness (WITH vs WITHOUT openlore).
 *
 * Drives a HEADLESS agent (`claude -p --output-format json`) over a fixed task
 * suite against pinned OSS repos, once WITH the openlore MCP server configured
 * and once WITHOUT, and records tokens / tool-calls / cost / wall-clock so the
 * project's headline "orient replaces a file-by-file orientation pass" claim can
 * be MEASURED instead of asserted. Sibling to the latency benches
 * (`bench.ts`/`bench-mcp.ts`/`bench-watch.ts`) — it answers a different question
 * (end-to-end agent round-trips), and leaves them untouched.
 *
 *   npm run bench:agent -- --dry-run                 # validate the pipeline, $0, no agent calls
 *   npm run bench:agent -- --dry-run --verify-oracle # also grep each clone to confirm expected answers
 *   npm run bench:agent -- --runs 4 --model sonnet   # the real, paid run (needs agent auth)
 *
 * Scope contract (Spec 14): pure addition. No runtime/library/API change; the
 * existing benches and their npm entry points are unmodified.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { REPOS, TASKS, type PinnedRepo, type BenchTask } from './bench-agent.tasks.js';

// ── CLI args ────────────────────────────────────────────────────────────────
interface Opts {
  dryRun: boolean;
  verifyOracle: boolean;
  runs: number;
  model: string;
  repos?: Set<string>;
  tasks?: Set<string>;
  work: string;
  out: string;
  maxBudgetUsd: number;
  skipSetup: boolean;
  withFullTools: boolean;   // WITH exposes all ~45 tools instead of a lean preset
  withPreset: string;       // lean tool preset for the WITH arm (default: navigation)
  leanOrient: boolean;      // instruct the WITH arm to call orient with lean:true (Spec 27)
}

function parseArgs(argv: string[]): Opts {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (flag: string): Set<string> | undefined => {
    const v = get(flag);
    return v ? new Set(v.split(',').map((s) => s.trim()).filter(Boolean)) : undefined;
  };
  return {
    dryRun: argv.includes('--dry-run'),
    verifyOracle: argv.includes('--verify-oracle'),
    runs: parseInt(get('--runs') ?? '4', 10),
    model: get('--model') ?? 'sonnet',
    repos: list('--repos'),
    tasks: list('--tasks'),
    work: get('--work') ?? join(tmpdir(), 'openlore-bench-agent'),
    out: get('--out') ?? join(process.cwd(), 'docs', 'AGENT-BENCHMARKS.md'),
    maxBudgetUsd: parseFloat(get('--max-budget-usd') ?? '2'),
    skipSetup: argv.includes('--skip-setup'),
    withFullTools: argv.includes('--with-full-tools'),
    withPreset: get('--with-preset') ?? 'navigation',
    leanOrient: argv.includes('--lean-orient'),
  };
}

// ── Metrics ─────────────────────────────────────────────────────────────────
// Tokens are broken out because the WITH condition loads ~45 MCP tool
// definitions into the system prompt every call: that shows up as a large but
// CHEAP cached-read component, so a single lumped "tokens" number flatters
// WITHOUT and is misleading. `costUsd` is the honest bottom line (it prices
// fresh vs cached correctly); the token breakdown is for transparency.
interface Metrics {
  freshInputTokens: number;  // input_tokens + cache_creation — processed fresh by the model
  cacheReadTokens: number;   // cache_read_input_tokens — amortized, ~10× cheaper
  outputTokens: number;
  costUsd: number;
  numTurns: number;     // round-trip proxy for tool-call count (json output exposes turns, not raw tool calls)
  durationMs: number;
  answer: string;
  correct: boolean;
  error?: string;
}

type Condition = 'without' | 'with';

/** Everything below this line in the results doc is regenerated each run; the
 *  hand-written findings/interpretation live above it and are preserved. */
const AUTOGEN_MARKER = '<!-- BENCH-AGENT:AUTOGEN BELOW — regenerated each run; edit findings ABOVE this line -->';

// ── Repo setup (clone @ pinned SHA, analyze for the WITH index) ──────────────
function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function ensureRepo(repo: PinnedRepo, work: string): string {
  const dir = join(work, repo.id);
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    sh('git', ['init', '-q'], dir);
    sh('git', ['remote', 'add', 'origin', repo.url], dir);
  }
  // Fetch only the pinned commit's history shallowly, then check it out.
  sh('git', ['fetch', '-q', '--depth', '1', 'origin', repo.sha], dir);
  sh('git', ['checkout', '-q', repo.sha], dir);
  return dir;
}

function ensureAnalyzed(repoDir: string): void {
  if (existsSync(join(repoDir, '.openlore', 'analysis', 'llm-context.json'))) return;
  // `analyze` requires an .openlore/config.json — `init` creates it (idempotent).
  if (!existsSync(join(repoDir, '.openlore', 'config.json'))) {
    sh('openlore', ['init'], repoDir);
  }
  // Deterministic, no LLM, no network: BM25/structural index only.
  sh('openlore', ['analyze', '--no-embed'], repoDir);
}

/**
 * MCP config files for the two arms. Both arms run with `--strict-mcp-config` so
 * the agent uses ONLY these files and ignores the user's global/project MCP
 * config — otherwise a globally-registered openlore would leak into the WITHOUT
 * baseline and erase the very difference we measure. (CodeGraph's published
 * benchmark uses the same `--strict-mcp-config` isolation.)
 */
/** The repo's freshly-built CLI — so the bench tests THIS code (incl. new
 *  presets), not whatever `openlore` version happens to be installed globally. */
function localCli(): string {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
  const cli = join(repoRoot, 'dist', 'cli', 'index.js');
  if (!existsSync(cli)) throw new Error(`Local build not found at ${cli} — run \`npm run build\` first.`);
  return cli;
}

function writeMcpConfigs(work: string, opts: { fullTools: boolean; preset: string }): { openlore: string; empty: string } {
  // WITH = openlore as recommended. By default a lean **--preset** (navigation:
  // 7 graph-traversal tools) rather than the full ~45 — the MCP best-practice
  // that tool schemas for tools the agent never calls are pure per-request
  // overhead. `--with-full-tools` exposes all 45 for the overhead comparison.
  const cli = localCli();
  const oloreArgs = ['mcp', '--no-watch-auto', ...(opts.fullTools ? [] : ['--preset', opts.preset])];
  const openlore = join(work, `openlore-mcp-${opts.fullTools ? 'full' : opts.preset}.json`);
  writeFileSync(openlore, JSON.stringify({ mcpServers: { openlore: { command: 'node', args: [cli, ...oloreArgs] } } }, null, 2), 'utf-8');
  // WITHOUT = no MCP at all (empty server map) under --strict-mcp-config.
  const empty = join(work, 'empty-mcp.json');
  writeFileSync(empty, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
  return { openlore, empty };
}

// ── Oracle verification (grep the clone for each expected substring) ─────────
function fileList(dir: string): string[] {
  const out: string[] = [];
  const skip = new Set(['.git', 'node_modules', '.openlore', 'dist', 'build', 'vendor']);
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (skip.has(e.name)) continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|js|jsx|py|go|rs|java|kt|swift|rb|php|cs|c|cc|cpp|h|hpp)$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** True if `needle` appears as a path substring or as a token inside any source file. */
function oracleFound(repoDir: string, needle: string): boolean {
  const files = fileList(repoDir);
  if (files.some((f) => relative(repoDir, f).includes(needle))) return true;
  for (const f of files) {
    try {
      if (statSync(f).size < 2 * 1024 * 1024 && readFileSync(f, 'utf-8').includes(needle)) return true;
    } catch { /* skip */ }
  }
  return false;
}

// ── Agent driver ────────────────────────────────────────────────────────────
function score(task: BenchTask, answer: string): boolean {
  const a = answer.toLowerCase();
  return task.expect.mustInclude.every((s) => a.includes(s.toLowerCase()));
}

function runAgent(task: BenchTask, repoDir: string, condition: Condition, opts: Opts, configs: { openlore: string; empty: string }, runIdx: number): Metrics {
  if (opts.dryRun) {
    // MOCK: exercise the scoring + aggregation pipeline at $0, no agent call.
    // WITH gets a fuller answer (includes the expected substrings) and fewer
    // round-trips than WITHOUT, so the table renders a representative shape.
    // These numbers are SYNTHETIC and never written to the committed results doc.
    const base = (task.id.length + runIdx) % 5;
    const withCond = condition === 'with';
    const answer = withCond
      ? `[mock] ${task.expect.mustInclude.join(', ')}`
      : `[mock] partial — ${task.expect.mustInclude.slice(0, 1).join(', ')}`;
    return {
      freshInputTokens: withCond ? 4000 + base * 100 : 14000 + base * 400,
      cacheReadTokens: withCond ? 30000 + base * 500 : 6000 + base * 200,
      outputTokens: withCond ? 300 + base * 10 : 900 + base * 30,
      costUsd: withCond ? 0.040 + base * 0.001 : 0.045 + base * 0.003,
      numTurns: withCond ? 2 + (base % 2) : 6 + base,
      durationMs: withCond ? 9000 + base * 300 : 26000 + base * 900,
      answer,
      correct: score(task, answer),
    };
  }

  const args = [
    '-p', task.prompt,
    '--output-format', 'json',
    '--model', opts.model,
    '--max-budget-usd', String(opts.maxBudgetUsd),
    '--no-session-persistence',
    // Read-only orientation tasks in throwaway clones: let the agent use its
    // tools without prompts, identically in both conditions, so the only
    // difference is whether the openlore MCP is configured.
    '--permission-mode', 'bypassPermissions',
    // Keep both conditions grounded in the repo — neither may "cheat" by
    // googling the library's internals.
    '--disallowedTools', 'WebSearch', 'WebFetch',
    // Use ONLY the configs we pass — ignore the user's global/project MCP so a
    // globally-registered openlore can't leak into the WITHOUT baseline.
    '--strict-mcp-config',
    '--mcp-config', condition === 'with' ? configs.openlore : configs.empty,
  ];
  if (condition === 'with') {
    // WITH = openlore AS INSTALLED: the shipped orient skill instructs the agent
    // to call orient() before reading files. Without this the agent may ignore
    // the tools and grep anyway (paying the MCP overhead for nothing), which
    // tests "tools present" rather than the actual product claim. This is a
    // faithful, minimal mirror of skills/openlore-orient/SKILL.md — not a nudge
    // beyond what a real openlore install gives the agent.
    args.push('--append-system-prompt',
      'This project uses OpenLore for architectural memory. BEFORE reading source ' +
      'files, call the openlore `orient` tool (mcp__openlore__orient) with your task' +
      (opts.leanOrient ? ' and pass `lean: true` (this is a shallow lookup)' : '') + ' — ' +
      'it returns the relevant functions, their callers, matching specs, and insertion ' +
      'points in one call. If you are reading source files without having called orient ' +
      'first, you are probably wasting tokens.');
  }

  const t0 = Date.now();
  let raw: string;
  try {
    raw = sh('claude', args, repoDir);
  } catch (err) {
    const e = err as { stdout?: Buffer | string; message?: string };
    const out = e.stdout ? e.stdout.toString() : '';
    if (!out) {
      return { freshInputTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0, numTurns: 0, durationMs: Date.now() - t0, answer: '', correct: false, error: e.message ?? 'agent failed' };
    }
    raw = out; // some non-zero exits still emit the result json
  }

  const j = JSON.parse(raw) as Record<string, unknown>;
  const usage = (j.usage ?? {}) as Record<string, number>;
  const fresh = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const answer = String(j.result ?? '');
  return {
    freshInputTokens: fresh,
    cacheReadTokens: cacheRead,
    outputTokens: output,
    costUsd: Number(j.total_cost_usd ?? 0),
    numTurns: Number(j.num_turns ?? 0),
    durationMs: Number(j.duration_ms ?? Date.now() - t0),
    answer,
    correct: score(task, answer),
  };
}

// ── Aggregation ─────────────────────────────────────────────────────────────
const median = (xs: number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

interface Cell {
  costUsd: number; costMin: number; costMax: number;   // bottom line + variance
  freshInputTokens: number; cacheReadTokens: number; outputTokens: number;
  numTurns: number; durationMs: number; correctRate: number; n: number;
}
function summarize(runs: Metrics[]): Cell {
  const costs = runs.map((r) => r.costUsd);
  return {
    costUsd: median(costs),
    costMin: costs.length ? Math.min(...costs) : 0,
    costMax: costs.length ? Math.max(...costs) : 0,
    freshInputTokens: median(runs.map((r) => r.freshInputTokens)),
    cacheReadTokens: median(runs.map((r) => r.cacheReadTokens)),
    outputTokens: median(runs.map((r) => r.outputTokens)),
    numTurns: median(runs.map((r) => r.numTurns)),
    durationMs: median(runs.map((r) => r.durationMs)),
    correctRate: runs.length ? runs.filter((r) => r.correct).length / runs.length : 0,
    n: runs.length,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────
function pct(withV: number, withoutV: number): string {
  if (withoutV === 0) return '—';
  const delta = (1 - withV / withoutV) * 100;
  return `${delta >= 0 ? '−' : '+'}${Math.abs(delta).toFixed(0)}%`;
}

function renderReport(
  opts: Opts,
  perTask: Array<{ task: BenchTask; without: Cell; with: Cell }>,
): string {
  const L: string[] = [];
  L.push('## Measured run — auto-generated by `npm run bench:agent` (Spec 14)');
  L.push('');
  L.push(opts.dryRun ? '> **DRY RUN — synthetic mock numbers, not a real measurement.**' : '');
  L.push('');
  L.push('### Methodology');
  L.push('');
  L.push(`- **Agent:** \`claude -p --output-format json\`, model \`${opts.model}\`, ${opts.runs} run(s)/task, median reported.`);
  L.push(`- **Isolation:** both arms run with \`--strict-mcp-config\` so the agent uses ONLY the config we pass (a globally-registered openlore can't leak into the baseline). Same as CodeGraph's published benchmark.`);
  L.push(`- **Conditions:** WITHOUT = empty MCP config (grep/read tools only) — the baseline. WITH = openlore (the repo's **local build**): \`openlore mcp --no-watch-auto ${opts.withFullTools ? '' : '--preset ' + opts.withPreset}\` (${opts.withFullTools ? 'all ~45 tools' : `**--preset ${opts.withPreset}** — a lean graph-navigation surface, the MCP best-practice of not paying schema overhead for tools the agent never calls`}), repo pre-analyzed with \`openlore analyze --no-embed\`, **plus** a system-prompt instruction to call \`orient()\` before reading files (a faithful mirror of the shipped \`openlore-orient\` skill — measures the product, not tools the agent ignores).`);
  L.push('- **Scoring:** correct = the agent\'s final answer contains every independently-verifiable expected substring (`expect.mustInclude` in `bench-agent.tasks.ts`), confirmed against the pinned source by grep — not derived from openlore\'s own graph.');
  L.push('- **Metrics:** **cost (USD)** is the bottom line (it prices fresh vs cached tokens correctly). Tokens are broken into *fresh* input (`input_tokens` + cache creation — what the model processed fresh) and *cached* reads (`cache_read_input_tokens` — ~10× cheaper); plus output, round-trips (`num_turns`), wall-clock.');
  L.push('');
  L.push('### Pinned repos');
  L.push('');
  L.push('| Repo | Lang | Tag | SHA |');
  L.push('|------|------|-----|-----|');
  for (const r of REPOS) L.push(`| ${r.id} | ${r.language} | ${r.tag} | \`${r.sha.slice(0, 12)}\` |`);
  L.push('');
  L.push('### Per-task results (median; cost [min–max] across runs)');
  L.push('');
  L.push('| Task | Kind | Correct wo/w | Cost wo | Cost w | Δcost | Fresh-in wo/w | Cached wo/w | Out wo/w | Turns wo/w |');
  L.push('|------|------|--------------|---------|--------|-------|---------------|-------------|----------|------------|');
  for (const { task, without: o, with: w } of perTask) {
    L.push(
      `| ${task.id} | ${task.kind} | ${(o.correctRate * 100).toFixed(0)}%/${(w.correctRate * 100).toFixed(0)}% ` +
      `| $${o.costUsd.toFixed(3)} [${o.costMin.toFixed(3)}–${o.costMax.toFixed(3)}] | $${w.costUsd.toFixed(3)} [${w.costMin.toFixed(3)}–${w.costMax.toFixed(3)}] | ${pct(w.costUsd, o.costUsd)} ` +
      `| ${o.freshInputTokens.toFixed(0)}/${w.freshInputTokens.toFixed(0)} | ${o.cacheReadTokens.toFixed(0)}/${w.cacheReadTokens.toFixed(0)} | ${o.outputTokens.toFixed(0)}/${w.outputTokens.toFixed(0)} | ${o.numTurns.toFixed(0)}/${w.numTurns.toFixed(0)} |`,
    );
  }
  L.push('');
  L.push('_wo = WITHOUT openlore, w = WITH. Δcost negative = WITH is cheaper. Cost cells show median [min–max]._');
  L.push('');
  // Aggregate (relational tasks only — the control 'locate' task is where grep already wins).
  const relational = perTask.filter((p) => p.task.kind !== 'locate');
  const aggWoCost = median(relational.map((p) => p.without.costUsd));
  const aggWCost = median(relational.map((p) => p.with.costUsd));
  const aggWoFresh = median(relational.map((p) => p.without.freshInputTokens));
  const aggWFresh = median(relational.map((p) => p.with.freshInputTokens));
  const aggWoTurns = median(relational.map((p) => p.without.numTurns));
  const aggWTurns = median(relational.map((p) => p.with.numTurns));
  L.push('### Aggregate — relational tasks (graph-favourable)');
  L.push('');
  L.push(`- **Cost (bottom line):** $${aggWoCost.toFixed(3)} → $${aggWCost.toFixed(3)} (${pct(aggWCost, aggWoCost)})`);
  L.push(`- **Fresh input tokens:** ${aggWoFresh.toFixed(0)} → ${aggWFresh.toFixed(0)} (${pct(aggWFresh, aggWoFresh)})`);
  L.push(`- **Round-trips:** ${aggWoTurns.toFixed(0)} → ${aggWTurns.toFixed(0)} (${pct(aggWTurns, aggWoTurns)})`);
  L.push('');
  L.push('> Spec 13 kill-signal: if the relational-task reduction is small or negative, that is the earliest signal to re-weight toward the governance layer (specs 15+). Report losses honestly; do not bury this number.');
  L.push('');
  return L.join('\n');
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const repos = REPOS.filter((r) => !opts.repos || opts.repos.has(r.id));
  const tasks = TASKS.filter((t) => (!opts.tasks || opts.tasks.has(t.id)) && repos.some((r) => r.id === t.repo));

  console.error(`[bench-agent] ${opts.dryRun ? 'DRY RUN ' : ''}${tasks.length} task(s) over ${repos.length} repo(s), ${opts.runs} run(s) each, model=${opts.model}`);
  if (!opts.dryRun) {
    console.error('[bench-agent] LIVE run — this makes real, paid agent calls. Ctrl-C now to abort.');
  }

  mkdirSync(opts.work, { recursive: true });
  const configs = writeMcpConfigs(opts.work, { fullTools: opts.withFullTools, preset: opts.withPreset });

  // Setup: clone @ SHA + analyze (skip with --skip-setup to reuse a prior setup).
  const repoDirs = new Map<string, string>();
  for (const repo of repos) {
    const dir = opts.skipSetup ? join(opts.work, repo.id) : ensureRepo(repo, opts.work);
    if (!opts.skipSetup) ensureAnalyzed(dir);
    repoDirs.set(repo.id, dir);
    console.error(`[bench-agent] ready: ${repo.id} @ ${repo.sha.slice(0, 8)}`);
  }

  // Optional oracle verification: every expected substring must exist in the clone.
  if (opts.verifyOracle) {
    let bad = 0;
    for (const task of tasks) {
      const dir = repoDirs.get(task.repo)!;
      for (const needle of task.expect.mustInclude) {
        const ok = oracleFound(dir, needle);
        if (!ok) { bad++; console.error(`[oracle] MISSING in ${task.repo}: "${needle}" (task ${task.id})`); }
      }
    }
    console.error(bad === 0 ? '[oracle] all expected answers found in pinned sources ✓' : `[oracle] ${bad} expected answer(s) NOT found — fix bench-agent.tasks.ts`);
  }

  // Run.
  const perTask: Array<{ task: BenchTask; without: Cell; with: Cell }> = [];
  for (const task of tasks) {
    const dir = repoDirs.get(task.repo)!;
    const without: Metrics[] = [];
    const withRuns: Metrics[] = [];
    for (let i = 0; i < opts.runs; i++) {
      without.push(runAgent(task, dir, 'without', opts, configs, i));
      withRuns.push(runAgent(task, dir, 'with', opts, configs, i));
    }
    perTask.push({ task, without: summarize(without), with: summarize(withRuns) });
    console.error(`[bench-agent] done: ${task.id}`);
  }

  const report = renderReport(opts, perTask);
  if (opts.dryRun) {
    // Never overwrite the committed results doc with mock numbers.
    process.stdout.write(report + '\n');
    console.error('[bench-agent] dry run complete — report printed to stdout (committed doc untouched).');
  } else {
    // Preserve any hand-written interpretation above the marker — only the
    // mechanical methodology+table below it is regenerated on each run.
    let prefix = '';
    if (existsSync(opts.out)) {
      const cur = readFileSync(opts.out, 'utf-8');
      const i = cur.indexOf(AUTOGEN_MARKER);
      if (i >= 0) prefix = cur.slice(0, i);
    }
    writeFileSync(opts.out, prefix + AUTOGEN_MARKER + '\n\n' + report, 'utf-8');
    console.error(`[bench-agent] wrote ${opts.out}${prefix ? ' (preserved hand-written findings above the marker)' : ''}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

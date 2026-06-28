/**
 * Preset selection-accuracy benchmark — the agent half of the
 * DefaultSurfaceRevealsAllFaces gate (change: refine-happy-path-and-defaults).
 *
 * `bench-preset-surface.ts` measures the two DETERMINISTIC gate quantities (token
 * economy + face coverage). This harness measures the third — SELECTION ACCURACY:
 * does the wider `substrate` surface (navigation core + recall + verify_claim +
 * blast_radius) make an agent pick the WRONG tool more often than the lean
 * `navigation` surface?
 *
 * For each task it shows the model exactly the tools a given preset advertises
 * (the real TOOL_DEFINITIONS name + description) and asks for the single tool it
 * would call first, then scores against an independent expected answer. Two task
 * classes:
 *   - SHARED  — the correct tool is in BOTH presets (a navigation-core tool). This
 *     is the regression probe: do substrate's three extra governance tools confuse
 *     selection of the navigation tools?
 *   - GOVERNANCE — the correct tool is substrate-only (recall / verify_claim /
 *     blast_radius). navigation structurally cannot serve these (the tool is absent),
 *     so it should score 0 here while substrate scores high.
 *
 * The default flip clears iff substrate does NOT regress on SHARED accuracy.
 *
 * Uses the Claude Code CLI (`claude -p --output-format json`) — subscription auth,
 * no API key. Run: npx tsx scripts/bench-preset-selection.ts [--json] [--limit N] [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOL_DEFINITIONS, selectActiveTools } from '../src/cli/commands/mcp.js';
import { LEAN_DEFAULT_PRESET } from '../src/constants.js';

type TaskClass = 'shared' | 'governance';
interface SelTask {
  id: string;
  task: string;
  expected: string;
  cls: TaskClass;
}

/**
 * Independent corpus: each task's `expected` tool is the single most-correct first
 * call, decided by reading the tool descriptions — NOT derived from OpenLore's graph.
 */
const TASKS: SelTask[] = [
  // ── SHARED: correct tool is in BOTH navigation and substrate ──
  { id: 's1', cls: 'shared', expected: 'orient', task: "I'm starting a task to add rate limiting to the HTTP API. Get oriented to the relevant code first." },
  { id: 's2', cls: 'shared', expected: 'search_code', task: 'Find the function that validates JWT tokens, by meaning (I don\'t know its name).' },
  { id: 's3', cls: 'shared', expected: 'analyze_impact', task: 'What breaks if I change the parseConfig function? Give me the blast radius of that one symbol.' },
  { id: 's4', cls: 'shared', expected: 'find_path', task: 'Show me the cheapest call path from handleRequest to the database query layer.' },
  { id: 's5', cls: 'shared', expected: 'get_subgraph', task: 'Show the depth-2 call neighborhood (callers and callees) around processPayment.' },
  { id: 's6', cls: 'shared', expected: 'trace_execution_path', task: 'Find every execution path from handleCheckout to chargeCard.' },
  { id: 's7', cls: 'shared', expected: 'suggest_insertion_points', task: 'I want to add a new caching layer. Where in the code should I implement it?' },
  { id: 's8', cls: 'shared', expected: 'get_function_skeleton', task: 'Give me the stripped control-flow skeleton (no bodies) of the file src/auth/login.ts.' },
  { id: 's9', cls: 'shared', expected: 'get_landmarks', task: 'What are the most salient landmark functions to read first for the authentication task?' },
  { id: 's10', cls: 'shared', expected: 'get_map', task: 'Give me a task-scoped map of the code regions involved in payment processing.' },
  // ── GOVERNANCE: correct tool is substrate-only ──
  { id: 'g1', cls: 'governance', expected: 'recall', task: 'Before I edit the billing module, what durable notes or decisions are already anchored to that code?' },
  { id: 'g2', cls: 'governance', expected: 'verify_claim', task: "Before I tell the user 'processPayment is dead code', settle that claim against the graph with a citation." },
  { id: 'g3', cls: 'governance', expected: 'blast_radius', task: 'I have staged a diff and I am about to commit. Give me the pre-commit blast-radius briefing for it.' },
];

interface ToolDef { name: string; description?: string }

function toolMenu(preset: string): { names: Set<string>; menu: string } {
  const tools = selectActiveTools(TOOL_DEFINITIONS as ToolDef[], { preset });
  const names = new Set(tools.map((t) => t.name));
  const menu = tools
    .map((t) => `- ${t.name}: ${(t.description ?? '').replace(/\s+/g, ' ').trim()}`)
    .join('\n');
  return { names, menu };
}

function buildPrompt(menu: string, task: string): string {
  return [
    'You are an AI coding agent. Exactly these tools are available to you:',
    '',
    menu,
    '',
    `Task: ${task}`,
    '',
    'Which SINGLE tool would you call FIRST to make progress on this task?',
    'Respond with ONLY a compact JSON object and nothing else: {"tool":"<exact tool name from the list>"}',
  ].join('\n');
}

/** Run one selection through the Claude Code CLI; returns the chosen tool name or null. */
function askClaude(prompt: string, model: string): string | null {
  let out: string;
  try {
    out = execFileSync('claude', ['-p', prompt, '--output-format', 'json', '--model', model], {
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 8,
      timeout: 90_000,
    });
  } catch {
    return null;
  }
  let resultText: string;
  try {
    resultText = (JSON.parse(out) as { result?: string }).result ?? '';
  } catch {
    resultText = out;
  }
  const m = resultText.match(/\{\s*"tool"\s*:\s*"([^"]+)"\s*\}/);
  if (m) return m[1].trim();
  // Fallback: a bare tool-name token.
  const bare = resultText.trim().match(/^[`"']?([a-z_]+)[`"']?$/);
  return bare ? bare[1] : null;
}

interface Cell { correct: number; total: number; unparsed: number }
const fresh = (): Cell => ({ correct: 0, total: 0, unparsed: 0 });

function pct(c: Cell): string {
  return c.total === 0 ? 'n/a' : `${Math.round((c.correct / c.total) * 100)}%`;
}

function run(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const dryRun = argv.includes('--dry-run');
  const limitI = argv.indexOf('--limit');
  const limit = limitI >= 0 ? Number(argv[limitI + 1]) : TASKS.length;
  const modelI = argv.indexOf('--model');
  const model = modelI >= 0 ? argv[modelI + 1] : 'sonnet';
  const tasks = TASKS.slice(0, limit);

  const presets = [LEAN_DEFAULT_PRESET, 'substrate'];
  const menus = Object.fromEntries(presets.map((p) => [p, toolMenu(p)]));

  // per preset → per class accuracy
  const score: Record<string, { shared: Cell; governance: Cell; overall: Cell }> = {};
  for (const p of presets) score[p] = { shared: fresh(), governance: fresh(), overall: fresh() };
  const rows: Array<Record<string, unknown>> = [];

  for (const t of tasks) {
    const row: Record<string, unknown> = { id: t.id, cls: t.cls, expected: t.expected };
    for (const p of presets) {
      const { names, menu } = menus[p];
      const prompt = buildPrompt(menu, t.task);
      if (dryRun) {
        row[p] = `(dry-run; expected ${t.expected}; expected-in-preset=${names.has(t.expected)})`;
        continue;
      }
      const chosen = askClaude(prompt, model);
      const c = score[p];
      c[t.cls].total++; c.overall.total++;
      if (chosen === null) { c[t.cls].unparsed++; row[p] = 'UNPARSED'; continue; }
      const ok = chosen === t.expected;
      if (ok) { c[t.cls].correct++; c.overall.correct++; }
      row[p] = `${chosen}${ok ? ' ✓' : ' ✗'}`;
    }
    rows.push(row);
    if (!json && !dryRun) {
      process.stderr.write(`  [${t.id}] ${t.cls.padEnd(10)} expected ${t.expected.padEnd(24)} ` +
        presets.map((p) => `${p}=${row[p]}`).join('  ') + '\n');
    }
  }

  const nav = score[LEAN_DEFAULT_PRESET];
  const sub = score['substrate'];
  const sharedRegression = !dryRun && sub.shared.total > 0 && nav.shared.total > 0 &&
    (sub.shared.correct / sub.shared.total) < (nav.shared.correct / nav.shared.total);

  const summary = {
    model,
    presets,
    score,
    verdict: dryRun ? 'dry-run (no agent calls)' : {
      sharedAccuracyNavigation: pct(nav.shared),
      sharedAccuracySubstrate: pct(sub.shared),
      governanceAccuracyNavigation: pct(nav.governance),
      governanceAccuracySubstrate: pct(sub.governance),
      substrateRegressesOnSharedSelection: sharedRegression,
      flipCleared: !sharedRegression,
    },
  };

  if (json) {
    process.stdout.write(JSON.stringify({ rows, summary }, null, 2) + '\n');
  } else if (!dryRun) {
    const lines: string[] = ['', 'Selection-accuracy scorecard (Claude Code CLI):', ''];
    lines.push(`  preset        shared    governance   overall`);
    lines.push('  ' + '-'.repeat(50));
    for (const p of presets) {
      const s = score[p];
      lines.push('  ' + p.padEnd(12) + pct(s.shared).padStart(6) + '     ' + pct(s.governance).padStart(8) + '    ' + pct(s.overall).padStart(6));
    }
    lines.push('');
    lines.push(`  Regression probe — substrate vs navigation on SHARED tool selection: ` +
      `${sharedRegression ? 'REGRESSION' : 'no regression'}.`);
    lines.push(`  Default-flip (selection-accuracy half): ${summary.verdict instanceof Object && (summary.verdict as { flipCleared: boolean }).flipCleared ? 'CLEARED' : 'BLOCKED'}.`);
    lines.push('');
    process.stdout.write(lines.join('\n') + '\n');
  } else {
    process.stdout.write(JSON.stringify({ rows }, null, 2) + '\n');
  }

  // Persist a dated record for the change's evidence trail.
  if (!dryRun) {
    try {
      const dir = join(process.cwd(), '.openlore', 'bench');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'preset-selection.json'), JSON.stringify({ rows, summary }, null, 2));
    } catch { /* non-fatal */ }
  }
}

run();

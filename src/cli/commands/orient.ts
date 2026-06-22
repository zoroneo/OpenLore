/**
 * openlore orient command
 *
 * CLI surface for the orient tool (also exposed through the MCP server). Given
 * a task, returns the relevant functions, callers, spec sections, and insertion
 * points — as JSON (for tooling) or a human-readable summary.
 *
 * With no task it prints a short session-start primer instead of erroring, so
 * the SessionStart hook written by `openlore install`
 * (`npx --yes openlore orient --json`) is a no-op that injects useful context
 * rather than failing on every session start.
 */

import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../../utils/logger.js';
import { handleOrient } from '../../core/services/mcp-handlers/orient.js';
import { estimateTokens } from '../../core/services/llm-service.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';
import { buildInjection, extractPrompt } from './orient-inject.js';

interface OrientCliOptions {
  task?: string;
  directory?: string;
  limit?: string;
  tokenBudget?: string;
  lean?: boolean;
  json?: boolean;
  metrics?: boolean;
  inject?: boolean;
}

/** Read all of stdin (the hook prompt payload). Resolves '' when no stdin is piped. */
function readStdin(): Promise<string> {
  return new Promise(resolve => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve(data);
    };
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => (data += chunk));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
    // A hook must never hang the user's turn: if stdin neither closes nor errors,
    // proceed with whatever arrived (typically '' → pointer line).
    setTimeout(done, 2000).unref?.();
  });
}

/**
 * `orient --inject` — task-scoped context injection
 * (change: add-task-scoped-context-injection). Emits a bounded, attributed,
 * ignorable orientation block (or a single pointer line) to stdout for a
 * pre-turn agent hook. Reads the task from --task or the hook's stdin payload.
 * Always exits 0: a hook must never break the user's turn.
 */
async function runInject(directory: string, taskOpt: string | undefined): Promise<void> {
  let prompt = taskOpt ?? '';
  if (!prompt) {
    try {
      prompt = extractPrompt(await readStdin());
    } catch {
      prompt = '';
    }
  }
  try {
    // Keep stdout clean: handleOrient → validateDirectory writes a "[ok] …"
    // success line via console.log, which would otherwise pollute the injected
    // context. Redirect diagnostics to stderr (same discipline as --json mode)
    // so stdout carries only the orientation block.
    const block = await withQuietStdout(() => buildInjection(directory, prompt));
    if (block) console.log(block);
  } catch {
    // buildInjection is fail-open, but guard the print path too: never throw.
  }
}

/**
 * Opt-in performance readout (Issue #128). Off by default — nothing is measured
 * or printed unless the caller passes --metrics. Reported to stderr so it never
 * corrupts the JSON on stdout that the skill wrappers parse. Local-only: wall
 * time plus an estimate of the result's output size; no network, no LLM.
 */
function reportMetrics(startNs: bigint, result: Record<string, unknown>): void {
  const wallMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  const tokens = estimateTokens(JSON.stringify(result));
  process.stderr.write(
    `[orient:metrics] wall=${wallMs.toFixed(1)}ms output≈${tokens} tokens (local, no network)\n`
  );
}

/** True once `openlore analyze` has produced an llm-context artifact. */
function hasAnalysis(directory: string): boolean {
  return existsSync(join(directory, OPENLORE_ANALYSIS_REL_PATH, 'llm-context.json'));
}

/** Session-start primer printed when orient is invoked without a task. */
function printPrimer(directory: string, asJson: boolean): void {
  const ready = hasAnalysis(directory);
  if (asJson) {
    console.log(
      JSON.stringify(
        {
          openlore: ready ? 'ready' : 'no-analysis',
          message: ready
            ? 'OpenLore architectural memory is active. Call orient with a task before reading source files.'
            : 'OpenLore is installed but no analysis was found. Run "openlore analyze" to build the graph.',
          usage: 'openlore orient --json --task "<task description>"',
        },
        null,
        2
      )
    );
    return;
  }
  if (ready) {
    console.log('OpenLore architectural memory is active.');
    console.log('Call orient with a task before reading source files:');
    console.log('  openlore orient --task "<task description>"');
  } else {
    console.log('OpenLore is installed but no analysis was found.');
    console.log('Run "openlore analyze" to build the graph, then:');
    console.log('  openlore orient --task "<task description>"');
  }
}

/**
 * Run `fn` with console.log/info/warn redirected to stderr, then restore them.
 * handleOrient → validateDirectory writes a "[ok] Successfully validated
 * directory…" line to stdout via logger.success; in --json mode that would
 * corrupt the JSON the wrappers parse. The MCP server applies the same stdout
 * discipline (see startMcpServer). logger.error already uses stderr.
 */
async function withQuietStdout<T>(fn: () => Promise<T>): Promise<T> {
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  try {
    return await fn();
  } finally {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
  }
}

/** Concise human-readable rendering of a handleOrient result. */
function printHuman(result: Record<string, unknown>): void {
  if (result.error) {
    logger.error(String(result.error));
    if (result.hint) logger.info('Hint', String(result.hint));
    return;
  }

  const fns = (result.relevantFunctions as Array<{ name: string; filePath: string }>) ?? [];
  const ips =
    (result.insertionPoints as Array<{ rank: number; name: string; filePath: string; reason: string }>) ?? [];
  const next = (result.nextSteps as string[]) ?? [];

  console.log(`Task: ${result.task}`);
  console.log(`Search mode: ${result.searchMode}`);

  if (fns.length > 0) {
    console.log('\nRelevant functions:');
    for (const f of fns) console.log(`  ${f.name}  (${f.filePath})`);
  }
  if (ips.length > 0) {
    console.log('\nInsertion points:');
    for (const ip of ips) console.log(`  ${ip.rank}. ${ip.name}  (${ip.filePath}) — ${ip.reason}`);
  }
  if (next.length > 0) {
    console.log('\nNext steps:');
    for (const s of next) console.log(`  - ${s}`);
  }
}

export const orientCommand = new Command('orient')
  .description('Get the relevant functions, callers, specs, and insertion points for a task')
  .option('--task <task>', 'Natural-language task description (e.g. "add rate limiting to the API")')
  .option('--directory <path>', 'Project directory to orient in (default: current directory)')
  .option('--limit <n>', 'Number of relevant functions to return (default: 5)')
  .option('--token-budget <n>', 'Cap relevantFunctions to ~this many tokens (Spec 25 P4); highest-scored kept, exact duplicates collapsed')
  .option('--lean', 'Return only the navigation core — drop provenance/change-coupling/insertion-points/specs/decisions enrichment (Spec 27)', false)
  .option('--json', 'Emit the full result as JSON instead of a human-readable summary', false)
  .option('--metrics', 'Report wall time and output size to stderr (opt-in; off by default)', false)
  .option('--inject', 'Emit a bounded, ignorable task-scoped orientation block for a pre-turn agent hook (reads the task from --task or stdin); always exits 0', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore orient --task "add a new CLI command"
  $ openlore orient --json --task "fix the analyze cache"
  $ openlore orient --json --task "auth flow" --limit 10
  $ openlore orient --metrics --task "auth flow"   # opt-in wall-time/output-size readout

Requires "openlore analyze" to have been run at least once. With no --task,
prints a short session-start primer (used by the install SessionStart hook).
`
  )
  .action(async (opts: OrientCliOptions) => {
    const directory = opts.directory ?? process.cwd();
    const asJson = opts.json ?? false;
    const task = opts.task?.trim();

    // Task-scoped injection hook mode: emit a bounded orientation block (or a
    // pointer line) to stdout and always exit 0 — a pre-turn hook must never
    // break the user's turn. Reads the task from --task or stdin.
    if (opts.inject) {
      await runInject(directory, task);
      return;
    }

    // No task → session-start primer (keeps the install hook from erroring).
    if (!task) {
      printPrimer(directory, asJson);
      return;
    }

    const limit = opts.limit ? parseInt(opts.limit, 10) : 5;
    if (Number.isNaN(limit) || limit < 1) {
      logger.error('--limit must be a positive integer');
      process.exitCode = 1;
      return;
    }

    let tokenBudget: number | undefined;
    if (opts.tokenBudget !== undefined) {
      tokenBudget = parseInt(opts.tokenBudget, 10);
      if (Number.isNaN(tokenBudget) || tokenBudget < 1) {
        logger.error('--token-budget must be a positive integer');
        process.exitCode = 1;
        return;
      }
    }

    try {
      // In --json mode keep stdout clean (validateDirectory logs to stdout);
      // in human mode let diagnostics through normally.
      const lean = opts.lean ?? false;
      const startNs = opts.metrics ? process.hrtime.bigint() : 0n;
      const result = (asJson
        ? await withQuietStdout(() => handleOrient(directory, task, limit, tokenBudget, lean))
        : await handleOrient(directory, task, limit, tokenBudget, lean)) as Record<string, unknown>;
      if (opts.metrics) reportMetrics(startNs, result);
      // Always emit structured results (including the "no analysis" error object)
      // on stdout so wrapper scripts can parse them — mirroring the MCP tool.
      if (asJson) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printHuman(result);
      }
    } catch (err) {
      const message = (err as Error).message;
      if (asJson) {
        console.log(JSON.stringify({ error: message }, null, 2));
      } else {
        logger.error(`orient failed: ${message}`);
      }
      process.exitCode = 1;
    }
  });

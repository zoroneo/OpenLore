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
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';

interface OrientCliOptions {
  task?: string;
  directory?: string;
  limit?: string;
  json?: boolean;
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
  .option('--json', 'Emit the full result as JSON instead of a human-readable summary', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore orient --task "add a new CLI command"
  $ openlore orient --json --task "fix the analyze cache"
  $ openlore orient --json --task "auth flow" --limit 10

Requires "openlore analyze" to have been run at least once. With no --task,
prints a short session-start primer (used by the install SessionStart hook).
`
  )
  .action(async (opts: OrientCliOptions) => {
    const directory = opts.directory ?? process.cwd();
    const asJson = opts.json ?? false;
    const task = opts.task?.trim();

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

    try {
      // In --json mode keep stdout clean (validateDirectory logs to stdout);
      // in human mode let diagnostics through normally.
      const result = (asJson
        ? await withQuietStdout(() => handleOrient(directory, task, limit))
        : await handleOrient(directory, task, limit)) as Record<string, unknown>;
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

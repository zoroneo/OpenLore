/**
 * `openlore install` — auto-configure popular agent surfaces so they call
 * `orient()` automatically.
 *
 * Dispatches to one or more adapters depending on `--agent` / detection,
 * supports `--dry-run`, `--force`, and `--uninstall`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { detect, ALL_AGENTS, type AgentName, type DetectedSurface } from './detect.js';
import type { Adapter, ApplyContext, ApplyResult, PlannedChange } from './adapters/types.js';
import { agentsMdAdapter } from './adapters/agents-md.js';
import { claudeCodeAdapter } from './adapters/claude-code.js';
import { cursorAdapter } from './adapters/cursor.js';
import { clineAdapter } from './adapters/cline.js';
import { continueAdapter } from './adapters/continue.js';

const ADAPTERS: Record<AgentName, Adapter> = {
  'agents-md': agentsMdAdapter,
  'claude-code': claudeCodeAdapter,
  cursor: cursorAdapter,
  cline: clineAdapter,
  continue: continueAdapter,
};

async function loadTemplate(): Promise<string> {
  // Template lives next to this file in the source tree, but at runtime we
  // resolve via the compiled dist path.
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'templates', 'agent-instructions.md'),
    // tsx / source-run fallback
    join(here, '..', '..', '..', 'src', 'cli', 'install', 'templates', 'agent-instructions.md'),
  ];
  for (const p of candidates) {
    try {
      return await readFile(p, 'utf8');
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'openlore install: could not locate agent-instructions.md template (looked in dist + src)'
  );
}

export interface InstallOptions {
  agent?: AgentName;
  dryRun?: boolean;
  force?: boolean;
  uninstall?: boolean;
  cwd?: string;
  /**
   * After configuring agent surfaces, build the index so orient() works on the
   * very first session (init if needed, then analyze). Default true; set false
   * via `--no-analyze`. Skipped for --dry-run and --uninstall.
   */
  analyze?: boolean;
}

/**
 * Build the openlore index so the freshly-wired orient() returns results on the
 * user's first session instead of "No analysis found".
 *
 * Drives the real `init` and `analyze` CLI commands (not the programmatic API):
 * the searchable BM25 index that orient depends on is built by analyze's embed
 * step, which only the CLI command runs. Both commands read process.cwd(), so
 * we chdir into the target for the duration. Failures are non-fatal — the
 * surfaces are already wired, so we warn and tell the user to run analyze
 * themselves rather than failing the whole install.
 */
async function buildIndex(cwd: string): Promise<void> {
  const prevCwd = process.cwd();
  // init/analyze print their own multi-line CLI output ("Next step: run
  // generate", etc.) via console.log — noise inside install. Capture it to
  // stderr so install shows its own concise summary; logger.error still surfaces.
  const origLog = console.log;
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  };
  try {
    process.chdir(cwd);
    const { initCommand } = await import('../commands/init.js');
    const { analyzeCommand } = await import('../commands/analyze.js');

    logger.discovery('Building search index (BM25; no network required)…');
    console.log = toStderr;
    // init is idempotent (skips if config already exists); analyze builds the
    // BM25 index orient() reads — no embedding endpoint needed.
    await initCommand.parseAsync([], { from: 'user' });
    await analyzeCommand.parseAsync([], { from: 'user' });
    console.log = origLog;
    logger.success('Index built — orient() will return results in your next session.');
  } catch (err) {
    console.log = origLog;
    logger.warning(
      `Could not build the index automatically: ${(err as Error).message}`
    );
    logger.info('Next step', 'Run "openlore analyze" so orient() works in your next session');
  } finally {
    console.log = origLog;
    process.chdir(prevCwd);
  }
}

export async function runInstall(opts: InstallOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const template = await loadTemplate();

  let surfaces: DetectedSurface[];
  if (opts.agent) {
    if (!ALL_AGENTS.includes(opts.agent)) {
      logger.error(`Unknown agent surface "${opts.agent}". Known: ${ALL_AGENTS.join(', ')}`);
      return 2;
    }
    surfaces = [{ agent: opts.agent, root: cwd, markers: ['(explicit --agent)'] }];
  } else {
    surfaces = await detect(cwd);
  }

  logger.discovery(
    `${opts.uninstall ? 'Uninstalling' : 'Installing'} for ${surfaces.length} surface(s): ${surfaces
      .map((s) => s.agent)
      .join(', ')}`
  );

  let conflict = false;
  const allChanges: PlannedChange[] = [];
  const allWarnings: string[] = [];

  for (const surface of surfaces) {
    const adapter = ADAPTERS[surface.agent];
    const ctx: ApplyContext = {
      root: surface.root,
      instructionTemplate: template,
      dryRun: !!opts.dryRun,
      force: !!opts.force,
    };
    const result: ApplyResult = opts.uninstall
      ? await adapter.uninstall(ctx)
      : await adapter.apply(ctx);

    if (result.conflict) conflict = true;
    allChanges.push(...result.changes);
    allWarnings.push(...result.warnings);
  }

  printSummary(allChanges, allWarnings, !!opts.dryRun, !!opts.uninstall);

  if (conflict) {
    logger.error(
      'Hand-edited OpenLore block(s) detected. Re-run with --force to overwrite, or revert your edits.'
    );
    return 1;
  }

  // One-command setup: build the index so orient() works on the first session.
  // Opt out with --no-analyze; never runs for dry-run or uninstall.
  const shouldAnalyze = opts.analyze !== false && !opts.dryRun && !opts.uninstall;
  if (shouldAnalyze) {
    await buildIndex(cwd);
  } else if (!opts.dryRun && !opts.uninstall) {
    logger.info('Next step', 'Run "openlore analyze" so orient() works in your next session');
  }

  return 0;
}

function printSummary(
  changes: PlannedChange[],
  warnings: string[],
  dryRun: boolean,
  uninstall: boolean
): void {
  const verb = dryRun ? 'would' : 'did';
  for (const c of changes) {
    const tag =
      c.kind === 'create'
        ? `[${verb} create]`
        : c.kind === 'update'
          ? `[${verb} update]`
          : c.kind === 'delete'
            ? `[${verb} delete]`
            : '[noop]';
    if (c.kind === 'noop') logger.discovery(`${tag} ${c.summary}`);
    else logger.success(`${tag} ${c.summary}`);
    if (dryRun && c.preview) {
      const indented = c.preview
        .split('\n')
        .map((l) => '    ' + l)
        .join('\n');
      process.stderr.write(indented + '\n');
    }
  }
  for (const w of warnings) logger.warning(w);
  if (dryRun) {
    logger.discovery('Dry run — no files were written.');
  } else if (!uninstall) {
    logger.success('OpenLore install complete.');
  } else {
    logger.success('OpenLore uninstall complete.');
  }
}

export const installCommand = new Command('install')
  .description(
    'One-command setup: configure agent surfaces (Claude Code, Cursor, Cline, Continue, AGENTS.md) ' +
    'to call orient(), then build the index so orient works on your first session.'
  )
  .option('--agent <name>', 'Install only for a specific surface (claude-code, cursor, cline, continue, agents-md)')
  .option('--dry-run', 'Print the planned changes without writing any files', false)
  .option('--force', 'Overwrite OpenLore-managed blocks even if hand-edited', false)
  .option('--uninstall', 'Remove OpenLore-managed blocks and entries', false)
  .option('--analyze', 'Build the index after configuring surfaces (default: true)', true)
  .option('--no-analyze', 'Configure surfaces only; do not run init/analyze (run "openlore analyze" yourself later)')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore install                 Detect agents, wire them up, build the index
  $ openlore install --agent claude-code
  $ openlore install --no-analyze    Wire up surfaces only (skip index build)
  $ openlore install --dry-run       Preview changes without writing
  $ openlore install --uninstall     Remove OpenLore-managed entries

After install, orient() is available immediately — the configured MCP server
(\`openlore mcp\`) starts automatically when your agent launches, and the index
stays fresh as you edit (disable the file watcher with \`openlore mcp --no-watch-auto\`).
`
  )
  .action(async (opts: InstallOptions) => {
    const code = await runInstall(opts);
    if (code !== 0) process.exit(code);
  });

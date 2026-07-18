/**
 * `openlore status` — one read-only pane answering "what is OpenLore doing in
 * this repo right now?" (change: add-substrate-status-surface / SingleStatusConclusion).
 *
 * Composes existing signals only (index attestation, stale region, config,
 * install `surfaceStatus`, decisions store + ledger, update-notifier cache) into
 * one conclusion. No mutation, no LLM, no network, sub-second.
 *
 * Sibling conclusions (NoRedundantConclusions): `doctor` = is my ENVIRONMENT
 * healthy (and `--fix` it); `features` = what could I turn ON; `status` = what is
 * the substrate DOING right now. Each is a distinct question; none subsumes this.
 */

import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { collectStatusReport, type StatusReport } from '../../core/services/status-report.js';

interface Palette {
  ok: string;
  warn: string;
  bad: string;
  dim: string;
  bold: string;
  hint: string;
  reset: string;
}

function palette(useColor: boolean): Palette {
  return {
    ok: useColor ? '\x1b[32m' : '', // green
    warn: useColor ? '\x1b[33m' : '', // yellow
    bad: useColor ? '\x1b[31m' : '', // red
    dim: useColor ? '\x1b[2m' : '',
    bold: useColor ? '\x1b[1m' : '',
    hint: useColor ? '\x1b[36m' : '', // cyan
    reset: useColor ? '\x1b[0m' : '',
  };
}

/** A section header line + its detail lines, with an optional next-action line. */
function section(title: string, lines: string[], nextAction: string | undefined, p: Palette): void {
  console.log(`  ${p.bold}${title}${p.reset}`);
  for (const line of lines) console.log(`    ${line}`);
  if (nextAction) console.log(`    ${p.hint}→ ${nextAction}${p.reset}`);
  console.log('');
}

function verdictColor(verdict: string | null, p: Palette): string {
  switch (verdict) {
    case 'healthy':
      return p.ok;
    case 'degraded':
      return p.warn;
    case 'mismatched':
      return p.bad;
    default:
      return p.dim;
  }
}

function render(report: StatusReport, useColor: boolean): void {
  const p = palette(useColor);

  logger.section('openlore status');
  console.log('');

  // Index
  const idx = report.index;
  const idxLines: string[] = [];
  if (!idx.exists) {
    idxLines.push(`${p.dim}no index built yet${p.reset}`);
  } else {
    const ageColor = idx.stale ? p.warn : p.ok;
    idxLines.push(`built · ${ageColor}${idx.ageLabel}${p.reset}`);
    if (idx.integrity) {
      const c = verdictColor(idx.integrity, p);
      idxLines.push(`integrity: ${c}${idx.integrity}${p.reset}`);
    }
    if (idx.staleFileCount !== null && idx.staleFileCount > 0) {
      idxLines.push(`${p.warn}${idx.staleFileCount} file(s) in the stale region${p.reset}`);
    }
    if (idx.repairInFlight) {
      idxLines.push(`${p.warn}background repair in flight (${idx.repairInFlight.reason})${p.reset}`);
    }
  }
  section('Index', idxLines, idx.nextAction, p);

  // Search
  const searchLabel: Record<string, string> = {
    keyword: 'keyword (BM25)',
    'local-embeddings': 'local embeddings',
    'remote-endpoint': 'remote embeddings',
  };
  section(
    'Search',
    [`${searchLabel[report.search.mode]} · ${p.dim}${report.search.detail}${p.reset}`],
    report.search.nextAction,
    p,
  );

  // Live
  const live = report.live;
  const liveColor = live.serveDaemonRunning ? p.ok : p.dim;
  section('Live', [`${liveColor}${live.detail}${p.reset}`], undefined, p);

  // Wiring
  const w = report.wiring;
  const wLines: string[] = [];
  if (w.surfaces.length === 0) {
    wLines.push(`${p.dim}no agent surfaces detected${p.reset}`);
  } else {
    const connected = w.surfaces.filter((s) => s.connected).map((s) => s.agent);
    if (connected.length > 0) {
      wLines.push(`${p.ok}connected${p.reset}: ${connected.join(', ')} ${p.dim}(repo scope)${p.reset}`);
    } else {
      wLines.push(`${p.dim}no agent connected in this repo${p.reset}`);
    }
  }
  section('Wiring', wLines, w.nextAction, p);

  // Governance
  const g = report.governance;
  const gLines: string[] = [];
  const modeColor = g.mode === 'off' ? p.dim : p.ok;
  gLines.push(
    `gate: ${g.gateInstalled ? `${p.ok}installed${p.reset}` : `${p.dim}not installed${p.reset}`} · mode: ${modeColor}${g.mode}${p.reset}`,
  );
  if (g.pendingOnHuman > 0) {
    gLines.push(`${p.warn}${g.pendingOnHuman} decision(s) awaiting your review${p.reset}`);
  }
  if (g.autoAcceptedUnreviewed > 0) {
    gLines.push(`${p.hint}${g.autoAcceptedUnreviewed} auto-accepted, unreviewed${p.reset}`);
  }
  for (const e of g.recentLedger) {
    gLines.push(`${p.dim}· ${e.to} ${e.id} (${e.actor}) — ${e.title.slice(0, 48)}${p.reset}`);
  }
  section('Governance', gLines, g.nextAction, p);

  // Version
  const v = report.version;
  const vLines = [
    v.updateAvailable
      ? `${v.current} → ${p.warn}${v.updateAvailable} available${p.reset}`
      : `${v.current} ${p.dim}(latest known)${p.reset}`,
  ];
  section('Version', vLines, v.nextAction, p);
}

export const statusCommand = new Command('status')
  .description('Show what OpenLore is doing in this repo (index, search, wiring, governance)')
  .option('--json', 'Output the status report as JSON', false)
  .addHelpText(
    'after',
    `
Examples:
  $ openlore status          One pane: index freshness, search mode, wiring, governance
  $ openlore status --json   Machine-readable report (for scripts / agents)

Sibling commands (each answers a distinct question):
  openlore doctor     Is my environment healthy? (and how to fix it)
  openlore features   What can I turn on?
  openlore status     What is the substrate doing right now?
`,
  )
  .action(async (options: { json?: boolean }, command: Command) => {
    const root = process.cwd();
    const report = await collectStatusReport(root);

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Honor the global `--no-color` flag and the NO_COLOR convention, on top of
    // the TTY check (a pipe / redirect is never colored).
    const colorEnabled = command.optsWithGlobals().color !== false && !process.env.NO_COLOR;
    const useColor = Boolean(process.stdout.isTTY) && colorEnabled;
    const p = palette(useColor);

    // A repo with no OpenLore state gets one instruction, not a stack of empty
    // sections. Exit 0 — "nothing set up here" is not an error.
    if (!report.configured) {
      logger.section('openlore status');
      console.log('');
      console.log(`  ${p.dim}Nothing set up here yet.${p.reset}`);
      console.log(`  ${p.hint}→ openlore install${p.reset} — wire your coding agent and build the index`);
      console.log('');
      return;
    }

    render(report, useColor);
  });

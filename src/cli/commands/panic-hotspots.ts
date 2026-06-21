/**
 * openlore panic-hotspots
 *
 * The observe → memory feedback loop. Aggregates epistemic-lease telemetry into a deterministic,
 * per-module map of WHERE agents destabilize on this codebase, and (with --write) persists it as a
 * durable artifact the memory/orient layer can consume to pre-warn the next agent.
 *
 * Read-only by default; --write persists .openlore/analysis/behavioral-hotspots.json. Exits 0.
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { computeBehavioralHotspots } from '../../core/services/mcp-handlers/behavioral-hotspots.js';
import type { LeaseHotspotEvent, BehavioralHotspotReport } from '../../core/services/mcp-handlers/behavioral-hotspots.js';

const ARTIFACT_REL = join(OPENLORE_DIR, 'analysis', 'behavioral-hotspots.json');

function readLeaseEvents(directory: string): LeaseHotspotEvent[] {
  const path = join(directory, OPENLORE_DIR, 'telemetry', 'epistemic-lease.jsonl');
  if (!existsSync(path)) return [];
  const out: LeaseHotspotEvent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as LeaseHotspotEvent); } catch { /* skip malformed */ }
  }
  return out;
}

function render(report: BehavioralHotspotReport): string {
  const L: string[] = [];
  L.push('BEHAVIORAL HOTSPOTS — where agents destabilize (observe → memory)');
  L.push('────────────────────────────────────────────────────────────────');
  L.push(`observed: ${report.modules_observed} module(s) across ${report.generated_from_events} destabilization event(s)`);
  if (!report.hotspots.length) {
    L.push('  (no destabilization observed yet — run mode:\'observe\' to gather data)');
    return L.join('\n');
  }
  L.push('');
  for (const h of report.hotspots) {
    const labels = h.labels.length ? `  [${h.labels.join(', ')}]` : '';
    L.push(`  ${h.module}`);
    L.push(`    events ${h.events}  max-depth ${h.max_depth}  density ${h.avg_density}  oscillation ${h.avg_oscillation}${labels}`);
    if (h.tools.length) L.push(`    tools: ${h.tools.join(', ')}`);
  }
  L.push('');
  L.push('→ these are the regions orient/memory should pre-load context for. Persist with --write.');
  return L.join('\n');
}

export const panicHotspotsCommand = new Command('panic-hotspots')
  .description('Aggregate behavioral telemetry into per-module destabilization hotspots (observe → memory)')
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .option('--top <n>', 'Show only the top N hotspots', (v) => parseInt(v, 10), 0)
  .option('--json', 'Emit the hotspot report as JSON', false)
  .option('--write', 'Persist the report to .openlore/analysis/behavioral-hotspots.json', false)
  .action((options: { directory: string; top: number; json: boolean; write: boolean }) => {
    try {
      const events = readLeaseEvents(options.directory);
      const report = computeBehavioralHotspots(events, options.top > 0 ? options.top : 0);

      // Print the report FIRST — a --write failure must not swallow the computed output.
      process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : render(report) + '\n');

      if (options.write) {
        const path = join(options.directory, ARTIFACT_REL);
        try {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, JSON.stringify({ ...report, generatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf-8');
          if (!options.json) process.stdout.write(`\nwrote ${ARTIFACT_REL}\n`);
        } catch (e) {
          process.stderr.write(`panic-hotspots: could not write ${ARTIFACT_REL}: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    } catch {
      // fail-open: never break the caller
    }
    process.exit(0);
  });

/**
 * openlore panic-validate
 *
 * Observe-mode accuracy gate report. Reads panic.jsonl telemetry and prints the deterministic
 * evidence a maintainer needs before enabling any interventional panic posture by default.
 *
 * Read-only, no side effects. Always exits 0 (it is a report, not a gate that blocks). Use --json
 * for machine-readable output. The verdict is a mechanical read of the criteria — CLEARED only when
 * every criterion is met — and even CLEARED activates nothing (setup does, with acknowledgement).
 */

import { Command } from 'commander';
import { validatePanicSignal, readPanicTelemetry } from '../../core/services/mcp-handlers/panic-validation.js';
import type { PanicGateReport } from '../../core/services/mcp-handlers/panic-validation.js';

function pct(r: number | null): string {
  return r === null ? '—' : `${Math.round(r * 100)}%`;
}

function render(report: PanicGateReport): string {
  const L: string[] = [];
  const line = (s = '') => L.push(s);
  line('OBSERVE-MODE VALIDATION — panic signal accuracy gate');
  line('────────────────────────────────────────────────────────');
  line(`verdict                  : ${report.verdict}  (CLEARED = criteria met; activation still needs your acknowledgement)`);
  line(`episodes                 : ${report.episodes.completed} completed / ${report.episodes.total} total  (need ≥${report.min_episodes})`);
  const h = report.peak_level_histogram;
  line(`peak levels              : L1×${h.L1}  L2×${h.L2}  L3×${h.L3}  L4×${h.L4}`);
  line('');
  const fp = report.false_positive;
  line(`false-positive proxy     : ${pct(fp.proxy_rate)}  (upper bound: ${fp.resolved_via_decay}/${report.episodes.completed} resolved-by-decay, not re-orient; target ≤20%)`);
  if (fp.high_level_count > 0) line(`  high-level FP (L3+)     : ${fp.high_level_count}`);
  if (fp.by_trigger.length) {
    line('  by trigger (fp/all)    :');
    for (const t of fp.by_trigger) line(`    ${t.trigger.padEnd(20)} ${t.fp_episodes}/${t.all_episodes}  (${pct(t.fp_share)} fp)`);
  }
  line('');
  const iv = report.intervention;
  line(`intervention follow-thru : ${pct(iv.follow_through_rate)}  (${iv.responses}/${iv.hook_intercepts} intercepts → orient; target ≥50%)`);
  if (iv.avg_response_lag_ms != null) line(`  avg response lag       : ${iv.avg_response_lag_ms}ms`);
  const rz = report.resolution;
  line(`resolution               : ${pct(rz.completed_rate)} episodes resolved; recurrence ${rz.recurrence_count}; avg recovery ${rz.avg_recovery_ms != null ? rz.avg_recovery_ms + 'ms' : '—'}`);
  line('');
  const c = report.criteria;
  const mark = (b: boolean | null) => (b === null ? '—' : b ? '✓' : '✗');
  line(`criteria                 : data ${mark(c.data_sufficient)}  fp ${mark(c.fp_ok)}  follow-through ${mark(c.follow_through_ok)}`);
  line('');
  line('recommendations:');
  for (const r of report.recommendations) line(`  • ${r}`);
  return L.join('\n');
}

export const panicValidateCommand = new Command('panic-validate')
  .description('Observe-mode accuracy gate report from panic telemetry (read-only)')
  .option('-d, --directory <path>', 'Project directory', process.cwd())
  .option('--json', 'Emit the gate report as JSON', false)
  .option('--strict', 'Exit 1 if the gate criteria are not met (for CI/automation). Default exits 0.', false)
  .action((options: { directory: string; json: boolean; strict: boolean }) => {
    let exitCode = 0;
    try {
      const events = readPanicTelemetry(options.directory);
      const report = validatePanicSignal(events);
      process.stdout.write(options.json ? JSON.stringify(report, null, 2) + '\n' : render(report) + '\n');
      if (options.strict) {
        // Strict pass = enough data AND no criterion explicitly failing. follow_through is null in
        // pure observe mode (no interventions yet), which is acceptable for the observe→advisory step.
        const c = report.criteria;
        const pass = c.data_sufficient && c.fp_ok !== false && c.follow_through_ok !== false;
        exitCode = pass ? 0 : 1;
      }
    } catch {
      // fail-open: never break a maintainer's terminal (strict still reports failure via exit 1)
      if (options.strict) exitCode = 1;
    }
    process.exit(exitCode);
  });

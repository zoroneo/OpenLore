# Tasks — add-substrate-status-surface

> Status: IMPLEMENTED (2026-07-18). `openlore status` composes a read-only pane
> from existing signals via the shared collector `src/core/services/status-report.ts`
> and the thin CLI renderer `src/cli/commands/status.ts`. The index is opened with
> SQLite `immutable=1` so a `status` run creates no `-wal`/`-shm` sidecars and
> mutates nothing (the read-only guarantee, verified on a real analyzed index).

## Implementation
- [x] `src/cli/commands/status.ts` (+ shared `src/core/services/status-report.ts`):
      compose index (attestation verdict, age, stale count, repair-in-flight + reason —
      the last always null until make-index-self-healing lands), search mode (config),
      serve-daemon liveness, wiring (`surfaceStatus()`, repo scope; global scope pending
      unify-onboarding-entrypoint), governance (gate state, mode, pending-on-human,
      auto-accepted-unreviewed count, last 3 ledger entries), version (update-notifier
      cache) — read-only, no LLM, sub-second
- [x] Graceful degradation: bare repo → "nothing set up — run `openlore install`" (exit 0);
      each section renders its current truth when an optional dependency (autopilot ledger,
      repair service, global wiring scope) hasn't landed/isn't enabled
- [x] `--json` output; ≤1 next-action line per section; `--no-color` respected
      (via `command.optsWithGlobals().color` + the NO_COLOR convention)
- [x] Register in help-groups (beside its siblings doctor/features); sibling
      disambiguation prose vs doctor/features in the command description; docs entry
      (docs/cli-reference.md)

## Verification
- [x] Fixture tests per section: fresh repo, aged/stale index, real db integrity
      (healthy/unverifiable/mismatched/stale-region), autopilot with ledger entries,
      unwired bare repo, update available (status-report.test.ts)
- [x] Read-only guarantee: status run mutates no file — content, mtime, and file set
      unchanged, immutable open creates no sidecars (status-report.test.ts)
- [x] Latency bound test on a built fixture (< 1s)
- [x] Full suite green (289 files / 5661 tests); CLI scenarios (degradation exit 0, `--json`)
      in status.test.ts; `openspec validate add-substrate-status-surface` passes

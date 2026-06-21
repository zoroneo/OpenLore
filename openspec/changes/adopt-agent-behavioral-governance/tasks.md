# Tasks — Adopt the agent behavioral governance layer (staged)

> Rebase PR #83 onto current `main`. Land the core green; defer the heavy machinery. Call
> `record_decision` before the `panicResponse.mode` config contract and the
> `updatePanic()`/`updateTracker()` split (both architectural), per `CLAUDE.md`.

## 1. Integration onto current main (this PR — get to green)
- [x] Port net-new files: `panic-response.ts`, `panic-constants.ts`, `panic-check.ts`, `panic-level.ts`
      and their tests.
- [x] Add behavioral fields to `EpistemicTracker`; extract `updatePanic()` from `updateTracker()` and
      export it. `updateTracker()` (V4 freshness, `repoMovedSinceOrient`) stays unchanged and always runs.
- [x] Resolve `mcp.ts`: panic injection rides the **current** response path (`rawText` → `capOutput`),
      and `panic_level`/`panic_score` are added to main's richer `tool_call` emit (not a duplicate emit).
- [x] Resolve `telemetry.ts`: combine `redactSecrets()` (main, security) **with** rotation (PR). Redaction
      remains on every write.
- [x] Resolve `setup.ts`: DEFERRED the whole `setup` wiring (`--panic` **and** `--hooks`) to the hooks
      follow-up — setup.ts stays exactly as main (zero conflict / zero risk). This also sidesteps the
      `installClaudeHook` break (we never import it). Users opt in via `panicResponse.mode` in config.
- [x] Resolve `index.ts` (union command registration), `config-manager.ts`, `types/index.ts`.
- [x] `panicResponse.mode` added to `OpenLoreConfig`; ladder = `off | observe | advisory`; default `off`.
- [x] Reverted the PR's localityConfidence gate on **freshness** depth-escalation — `updateTracker()`
      semantics now identical to pre-panic main (panic:off is a zero-behavior-change path).
- [x] `tsc` clean; lint clean; full suite green (4240 passed, 2 skipped).

## 2. Safe defaults (this PR)
- [x] `mode: 'off'` default → zero panic overhead (`updatePanic()`/`writePanicState()` gated on
      `panicPolicy !== 'off'`; injection only at `advisory`).
- [x] `panic-check` and `panic-level` always exit 0 (fail-open) on every code path.
- [x] No hook auto-installed by `setup` (setup wiring deferred).
- [x] `updateTracker()` runs in all modes; only `updatePanic()` + `writePanicState()` are gated on mode.

## 3. Telemetry panic section (this PR)
- [x] `panic.jsonl` domain events with provenance (`panic_score_delta`, `panic_level_change`).
- [x] `openlore telemetry` panic summary (episodes, recovery latency, trigger frequency).

## 4. Decisions + spec sync (this PR)
- [ ] `record_decision`: adopt behavioral governance as an extension of the EpistemicLease nudge surface;
      core lands behind `mode:'off'`, intervention + Gryph + hooks deferred.
- [ ] `record_decision`: `panicResponse.mode` config contract; `updatePanic()`/`updateTracker()` split.
- [x] No new tool enters the default/minimal MCP surface (panic-check/panic-level are CLI commands, not
      MCP tools; no MCP tool added).

## Scope trim applied (Gryph / blocking / hooks deferred)
- [x] Removed `gryph-bridge.ts`, `gryph-watch.ts`, and their tests (external `safedep/gryph` binary +
      background daemon + CAS multi-writer) — deferred to its own change.
- [x] Removed `experimental_blocking` from the mode ladder (interventional enforcement) — deferred until
      observe-mode accuracy is validated.
- [x] Left inert plumbing in place for the deferred Gryph PR (`gryphWindowStart`, `revision`/CAS,
      `GRYPH_*` constants) — dormant, no build/behavior impact.

## 5. Deferred — follow-up PRs (NOT this PR)
- [ ] **Validate accuracy (the gate).** This PR lands the machinery green but does NOT prove the panic
      signal is accurate. Before any interventional posture ships on by default, `observe`-mode telemetry
      from real sessions must show: (a) a false-positive rate low enough that acting is net-positive
      (focused deep work must not trip L2+), (b) `panic_intervention_outcome` trending positive
      (orient-after-intervention, not ignored/fought), (c) episodes resolve rather than oscillate.
      Everything below is blocked on this gate.
- [ ] **`experimental_blocking`** mode — only after accuracy is shown.
- [ ] **Gryph** (`gryph-bridge.ts`, `gryph-watch.ts`, daemon, PID file, CAS, external binary) — evaluated
      on its own merits as a separate change.
- [ ] **Auto-installed hooks** via `setup --hooks` — after the core is validated.
- [ ] **observe → memory feedback loop** — turn behavioral observability into a durable memory/orient
      signal (the north-star payoff). Its own change proposal.

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
- [x] **Observe-mode validation readout** (`computePanicValidation`) — the deterministic measurement
      substrate for the accuracy gate: false-positive proxy (episodes resolved without re-orient),
      intervention follow-through (`panic_intervention_outcome` per intercept), and a gate verdict that
      is `INSUFFICIENT_DATA` / `REVIEW_REQUIRED` and **never auto-`CLEARED`** (clearing is a human call).
      This ships the *tooling to measure*; actually running observe-mode, gathering episodes, and
      deciding remains the follow-up (§5).

## 4. Decisions + spec sync (this PR)
- [ ] `record_decision`: adopt behavioral governance as an extension of the EpistemicLease nudge surface;
      core lands behind `mode:'off'`, intervention + Gryph + hooks deferred.
- [ ] `record_decision`: `panicResponse.mode` config contract; `updatePanic()`/`updateTracker()` split.
- [x] No new tool enters the default/minimal MCP surface (panic-check/panic-level are CLI commands, not
      MCP tools; no MCP tool added).

## 5. Full feature built in this PR (was deferred; now opt-in + off by default)
- [x] **Expanded observe-mode validation gate** — `openlore panic-validate` (+ `--json`):
      per-trigger false-positive attribution, peak-level histogram, intervention follow-through,
      pass/fail criteria, actionable recommendations; verdict `INSUFFICIENT_DATA`/`REVIEW_REQUIRED`,
      never auto-`CLEARED`. Also fixed the `call_triggers` bug (telemetry "triggers" was always empty).
- [x] **`experimental_blocking`** — back on the ladder as an EXPLICIT opt-in (never default); L4 emits
      `{decision:block, advisory:true}`. Below L4 == advisory.
- [x] **Gryph** (`gryph-bridge.ts`, `gryph-watch.ts`, CAS) — re-attached fail-open (no-op when the
      `gryph` binary is absent); `gryph-watch` exits silently on `off`. CAS/`gryphWindowStart`/`GRYPH_*`
      plumbing now live.
- [x] **`setup --hooks` / `--panic`** — opt-in installers; never installed by a default `setup`;
      reconciled with `--global`; no `installClaudeHook` dependency; interventional modes warn to validate.
- [x] **observe → memory feedback loop (end-to-end)** — `openlore panic-hotspots` (+ `--write`)
      persists `behavioral-hotspots.json`; `orient()` consumes it and surfaces a contextual
      `behavioralHotspots` block (fail-open, gated on mode != off, labeled-only, omitted in lean mode).
- [x] **`panic-validate --strict`** — opt-in non-zero exit for CI/automation (gate as an actual gate).

## 6. Accuracy validation — the in-code half (built)
- [x] **Deterministic replay** — injectable engine clock (behavior-preserving; full suite confirms)
      + `replayBehavioralTrace()` drives the real engine over a `(tool, filePath, gapMs)` trace.
      `openlore panic-replay <trace.jsonl>` replays a recorded/synthetic session → panic timeline.
- [x] **Labeled-corpus calibration** — `computeCalibration()` measures false-positive rate + sensitivity
      at the L2 threshold against a ground-truth corpus (coherent vs confused). `openlore panic-calibrate
      [--json] [--strict]`. CI asserts 0% FP, 100% sensitivity on the clear-cut corpus.
- [x] **Honest sensitivity disclosure** — the harness FOUND a real over-sensitivity
      (`occasional-cross-check`: dwell-insensitive oscillation trips on long-dwell work with periodic
      checks). Documented + regression-pinned, NOT silently changed (that's signal-design for the
      author). This is the evidence the gate must weigh.

## 7. Still gated / remaining (operations + data, not code)
- [ ] **Clear the gate on real data.** The machinery and the in-code accuracy harness are built; what
      remains is **not a code stub**: run `observe` mode on real sessions, then confirm with
      `openlore panic-validate` (use `--strict`) that (a) the false-positive rate is low (focused deep
      work doesn't trip L2+), (b) `panic_intervention_outcome` trends positive, (c) episodes resolve.
      Only then may a maintainer enable an interventional posture by default — a human decision.
- [ ] **(Optional follow-up) Dwell-aware oscillation.** The calibration documents a fix candidate for
      the over-sensitivity; the calibration harness now exists to validate any such change safely.

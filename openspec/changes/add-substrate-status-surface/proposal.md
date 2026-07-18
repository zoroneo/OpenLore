# One status surface: what OpenLore is doing in this repo, in one pane

> Status: PROPOSED (2026-07-18). A background tool earns invisibility only if the user can
> interrogate it in one place. Today the answer to "what is OpenLore doing here?" is
> scattered across five commands — `doctor` (environment diagnostics), `features` (opt-in
> inventory), `decisions --status` (gate state), `connect list` (wiring table), and the
> passive update notifier — and none of them answers the questions an autopilot-era user
> actually asks: *is my index fresh, is anything running, what did you accept for me, is
> anything waiting on me?* This change adds `openlore status`: one read-only,
> conclusion-shaped pane composed entirely from signals that already exist.

## The gap

- **Freshness state has no user-facing home.** The integrity verdict
  (`computeIndexIntegrity`, `src/core/services/mcp-handlers/utils.ts:32-47`), the stale
  region (`src/core/services/edge-store.ts:887-926`), and analysis age are computed on read
  and surfaced to *agents* via the freshness note — a human at the terminal has only
  doctor's coarse age warning.
- **Background activity is invisible.** Whether a watcher/daemon is live, whether a
  cold-start or repair build is in flight (`make-index-self-healing`), and what search mode
  is active (keyword vs local vs remote embeddings) are all knowable but nowhere shown.
- **The governance trail needs a front door.** With `add-decision-autopilot`, the ledger
  and the auto-accepted-unreviewed queue exist — but a user should not need to know the
  `decisions log`/`review` subcommands to discover something awaits them.
- **Doctor is the wrong shape for this.** Doctor answers "is my *environment* healthy"
  (Node floor, git, keys, disk) with pass/warn/fail semantics and fix hints. "What is the
  *substrate's current state* in this repo" is a different conclusion; overloading doctor
  would bury both.

## What changes

**`openlore status [--json]`** — read-only, no LLM, sub-second, degrades gracefully to
"nothing set up here — run `openlore install`" on a bare repo. Sections, all from existing
sources:

| Section | Content | Source |
|---|---|---|
| Index | exists · age · integrity verdict · stale-file count · build/repair in flight (reason) | attestation, edge store stale region, repair latch |
| Search | keyword / local embeddings / remote endpoint | config + corpus stamps |
| Live | watcher or serve daemon liveness for this repo | daemon discovery |
| Wiring | connected agent surfaces (repo + global scope) | `surfaceStatus()` |
| Governance | gate installed · mode (autopilot/review/off) · pending on the human · auto-accepted-unreviewed count · last 3 ledger entries | gate state, ledger |
| Version | current · cached update-available | update notifier cache |

Each section ends with at most one next-action line (the `features` discipline). The
description names its siblings per `NoRedundantConclusions`: *doctor* = is my environment
broken (and `--fix` it); *status* = what is the substrate doing right now; *features* =
what could I turn on.

**Deliberately CLI-only.** No new MCP tool: agents already receive freshness through the
lease/notes, and default-surface additions are gated by the ADR-0023 benchmark process.
If agent demand materializes, a tool goes through that gate as its own change.

## Impact

- Specs touched: `cli`.
- Likely code: new `src/cli/commands/status.ts` composing existing readers
  (`computeIndexIntegrity`, edge-store stale APIs, config-manager, install
  `surfaceStatus`, decisions gate-state + ledger, update-notifier cache); `help-groups.ts`
  (inspect group).
- Depends on: nothing hard. Ledger/autopilot rows render only when
  `add-decision-autopilot` has landed; repair-in-flight row only with
  `make-index-self-healing`. Each absent dependency degrades to the section's current
  truth (e.g. governance: "gate not installed").
- Cross-references (do not duplicate): `fix-cli-output-hygiene` (summary-line honesty,
  `--no-color`), `spec_store_status` (federation binding health stays its own conclusion,
  linked not inlined).

## Non-goals

- No mutation of any kind; no fix mode (that is `doctor --fix`).
- No new metrics, daemons, or persisted state — composition only.
- No MCP tool, no default-surface change.

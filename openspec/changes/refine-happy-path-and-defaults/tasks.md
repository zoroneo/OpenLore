# Tasks — refine the happy path: good defaults, best practices, one coherent surface

This change is a multi-requirement refinement; each requirement is independently shippable. Slices land
on their own branches/PRs and are checked off here as they ship.

## Slice 1 — `config` / ZeroConfigWithGuidedActivation  (SHIPPED — branch `feat/guided-feature-activation`)

- [x] Shared inventory: `collectFeatureInventory()` in `src/core/services/feature-inventory.ts` —
      deterministic, local, fail-soft; detects 11 features (9 opt-in) from `.openlore/config.json` +
      on-disk markers (`.mcp.json` preset, `.openlore/architecture.json`, `.git/hooks/pre-commit`,
      `.openlore/federation.json`). Returns `requiredConfigKeys: 0` to surface the zero-config guarantee.
- [x] CLI: `openlore features` (`src/cli/commands/features.ts`) — grouped human view + `--json` +
      `--inactive`; mirrors `doctor`'s rendering conventions; each inactive opt-in feature shows the one
      command/snippet to activate it.
- [x] Wire command into `src/cli/index.ts` (between `doctor` and `setup`) and name it in the front-door
      `--help` epilog (Core commands).
- [x] Tests: `feature-inventory.test.ts` (17 cases — every active/inactive branch, fail-soft, counts);
      `index-help.test.ts` discoverability guard (`openlore features` appears in the epilog).
- [x] Dogfood: ran `openlore features` / `--json` / `--inactive` on this repo (federation preset + gate
      hook + 2 peer repos detected) and on a synthetic all-features-on fixture (9/9 active) and a bare
      no-config dir (warns, exit 0, zero-config line preserved).
- [x] Verify: `tsc --noEmit` clean; `vitest run src examples` green (280 files, 5556 passed, 2 skipped).
- [x] Value preserved: no tool/command/preset removed; zero required keys unchanged; no LLM, no network.

## Slice 2 — `cli` / CommandSurfaceGroupedByJob  (SHIPPED — PR #218)

- [x] `src/cli/help-groups.ts`: `COMMAND_GROUPS` (6 job groups, ordered) + `groupForCommand()` +
      `groupedFormatHelp()` — a faithful Commander-12 `formatHelp` reproduction that groups only the
      Commands section; uncategorized commands fall to an "Other" group (never hidden).
- [x] Wire `program.configureHelp({ formatHelp: groupedFormatHelp })` in `src/cli/index.ts`.
- [x] Tests: `help-groups.test.ts` (6 — grouping, order, Other fallback, omit-empty-group, usage/options
      preserved) + `index-help.test.ts` wiring guard.
- [x] Dogfood: `openlore --help` renders all commands under their job groups; experimental suites under
      "Advanced / experimental"; epilog still follows; no OpenLore command in "Other".

## Slice 3 — `cli` / TruthfulDoctorExitCodes  (ALREADY SATISFIED in `main`)

- [x] `doctor` returns `warn` (not `fail`) for a missing LLM/embedding key; exits `0` on the no-LLM path.
- [x] Node floor checked to the minor version (≥ 22.5). Locked by existing `doctor.test.ts` cases.

## Slice 4 — `config` / DefaultsTrackCurrentLineage  (ALREADY SATISFIED in `main`)

- [x] `DEFAULT_ANTHROPIC_MODEL` is `claude-sonnet-4-6` (matches the runtime config default) — no drift.
- [x] `mcp-tool-count-doc.test.ts` already guards the documented tool count against `TOOL_DEFINITIONS`.
- [ ] (Optional follow-up) A language-count drift guard, if/when a doc states a hard language count.

## Slice 5 — `mcp-quality` / ConsistentToolNaming  (SHIPPED — PR #218)

- [x] Permanent alias mechanism: `TOOL_NAME_ALIASES` + `resolveCanonicalToolName()` in
      `mcp-handlers/tool-contract.ts` (single source of truth, prior → canonical).
- [x] Resolve aliases up front on BOTH transports: `mcp.ts` CallTool handler (covers schema lookup, arg
      validation, tracking, dispatch) + `tool-dispatch.ts` entry (covers `serve` HTTP + any direct caller).
- [x] Reconcile `get_ui_components` → `get_ui_component_inventory` across all sites: `TOOL_DEFINITIONS`,
      `TOOL_OUTPUT_CLASS`, `TOOL_CAPABILITY_FAMILY`, the `_RO` map, the dispatch case, `epistemic-lease`
      weights, the live-data tool driver, and the generated AGENTS.md / digest prose; prior name kept as alias.
- [x] Docs: `docs/mcp-tools.md` (canonical + alias note), `docs/agent-setup.md` (inventory lines).
- [x] Guards: `tool-aliases.test.ts` (alias→registered, no-collision, passthrough, snake_case,
      inventory-suffix family). `tool-contract.test.ts` (completeness/no-stale) stays green after the rename.
- [x] Dogfood (real stdio JSON-RPC): old `get_ui_components` dispatches (not unknown-tool); canonical
      dispatches; a genuinely unknown name still returns unknown-tool. `tools/list` shows only the canonical.
- [x] `remember`/`recall`/`orient` intentionally NOT renamed (no value-destroying churn — Non-goals).

## Slice 6 — `mcp-handlers` / ReadyOrHonestFirstUse  (SHIPPED — PR #218; default surface + core graph primitives)

- [x] Shared helper `notReadyResult(message, reason)` in `mcp-handlers/utils.ts` → structured
      `{ error, notReady: true, reason: 'index-absent' | 'graph-unavailable', remedy: 'openlore analyze' }`;
      human `error` preserved verbatim (existing `.error` callers/tests unaffected).
- [x] Routed every graph-dependent guard in the navigation (default) preset + core graph primitives
      through it: `graph.ts` (19 sites — subgraph, call_graph, impact, trace, signatures, file-deps, …),
      `orient.ts`, `pathfind.ts` (find_path), `map.ts` (get_map), `landmarks.ts` (get_landmarks),
      `semantic.ts` (search_code, suggest_insertion_points).
- [x] Tests: `utils.test.ts` notReadyResult unit cases; updated the `./utils.js` mocks in the affected
      handler tests; full suite green.
- [x] Dogfood (real stdio, bare repo): every navigation-preset graph tool returns `notReady:true` +
      `reason` + `remedy:'openlore analyze'`; `get_function_skeleton` correctly OUT of scope (reads
      source files, not the graph); a genuinely unknown tool still errors.
- [x] Scope note: pre-existing behavior was already honest (never silent-empty); this makes it
      machine-actionable + consistent. Opt-in specialized handlers stay honest, migrate opportunistically.

## Slice 7 — `overview` / DocumentationSingleSourceOfTruth  (SHIPPED — PR #218)

- [x] `docs/README.md` — task→doc index (intent → one canonical page), grouped by job; linked from the
      top-level README "Documentation" section.
- [x] Canonical designations + cross-link banners on the overlapping pages: `language-support.md` ↔
      `languages.md`, `install.md` ↔ `agent-setup.md`, `configuration.md` ↔ `providers.md`.
- [x] "Historical" banners on stale pages (`RENAME-TO-OPENLORE.md`, `plan-rag-improvements.md`) pointing
      to the index — redirect-only, no reference content deleted.
- [x] Guard: `docs-index.test.ts` (index exists; every relative link resolves; canonical pages present).

## Slice 8 — `cli` / GuaranteedIndexAtFirstSession  (ALREADY SATISFIED in `main`)

- [x] `install` builds the index by default; skipped/failed build prints the one remediation
      ("Next step: Run \"openlore analyze\"" — `src/cli/install/index.ts`).
- [x] Cold-start self-bootstrap (`cold-start-bootstrap.ts`); schema-reset self-heal via detached
      `analyze --force` (`mcp-watcher.ts`). No code change required.

## Slice 9 — `mcp-handlers` / ConciseByDefaultDetailedOnRequest  (SHIPPED — PR #218; first increment)

- [x] Shared mechanism in `progressive.ts`: `ResponseFormat` type, `normalizeResponseFormat()`
      (concise-by-default; only the exact `'detailed'` opts into the full payload), `truncationReceipt()`.
- [x] Applied to `get_duplicate_report` (the most-verbose tool): concise summary by default
      (stats + top 10 clone groups + truncation receipt); `responseFormat:"detailed"` returns the full
      report. Dispatch + inputSchema (enum) + description updated.
- [x] Tests: `progressive.test.ts` (normalize/receipt units) + `analysis.test.ts` (concise default,
      detailed pass-through, truncation receipt, bad-value→concise, fail-soft on unknown shape).
- [x] Dogfood (real stdio): 87% smaller by default (3.0 KB vs 23.9 KB; 68 groups → top 10 + "58 omitted").
- [x] Sub-parts already satisfied surface-wide: truncation receipts (`coverage-gaps` `omitted`,
      `public-surface` `truncated`, `briefing-since` `buildTruncationReceipt` — "no silent cap") and
      output budgets. Remaining verbose tools (inventory family) adopt the helper opportunistically.

## Remaining slices (blocked on external dependencies — no clean code left in this change)

- [ ] `mcp-quality` / DefaultSurfaceRevealsAllFaces — the `substrate` preset (mechanism) exists; the
      default flip is **benchmark-gated** and the agent benchmark has not been run here.
- [ ] `mcp-quality` / ProgressiveCatalogDisclosure — native `defer_loading` is a host/API feature, not an
      MCP-server capability; the server-side answer (preset system + `annotations.family`) already ships.
- [x] `mcp-quality` / NoRedundantConclusions (prose) — the sibling cross-reference is ALREADY ENFORCED by
      `tool-contract.test.ts` ("each member names at least one near-sibling in its own description"); the
      remaining "lead-with-action" prose quality is not deterministically testable and is left as-is.

## Verification (PR #218, after slices 1, 2, 5, 6, 7, 9)

- [x] `npm run build` clean; `tsc --noEmit` clean.
- [x] `vitest run src examples` green — 283 files, 5581 passed, 2 skipped (the lone intermittent
      `mcp-watcher-parity` flake under full-suite load is pre-existing and passes in isolation).
- [x] Value preserved: no tool/command/preset/language removed (a tool was renamed with a permanent
      alias — the prior name still works); zero required keys unchanged; no LLM, no network, no artifact.
- [ ] `openspec validate refine-happy-path-and-defaults` (run at archive time).

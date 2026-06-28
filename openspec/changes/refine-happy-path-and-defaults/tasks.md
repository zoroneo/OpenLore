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

## Remaining slices (not started — each independently shippable)

- [ ] `mcp-quality` / DefaultSurfaceRevealsAllFaces — run the substrate-vs-navigation benchmark; flip default.
- [ ] `mcp-quality` / ProgressiveCatalogDisclosure — adopt Tool Search / `defer_loading` where supported.
- [ ] `mcp-quality` / NoRedundantConclusions (prose) — sibling "use X instead" in description prose.
- [ ] `mcp-handlers` / ConciseByDefaultDetailedOnRequest — `responseFormat` + truncation receipts.
- [ ] `cli` / GuaranteedIndexAtFirstSession — surface skipped/failed build with its one remediation.
- [ ] `overview` / DocumentationSingleSourceOfTruth — one canonical page per concept; task→doc index.

## Verification (PR #218, after slices 1, 2, 5, 6)

- [x] `npm run build` clean; `tsc --noEmit` clean.
- [x] `vitest run src examples` green — 282 files, 5572 passed, 2 skipped.
- [x] Value preserved: no tool/command/preset/language removed (a tool was renamed with a permanent
      alias — the prior name still works); zero required keys unchanged; no LLM, no network, no artifact.
- [ ] `openspec validate refine-happy-path-and-defaults` (run at archive time).

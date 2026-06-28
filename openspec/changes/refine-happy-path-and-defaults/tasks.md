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

## Slice 2 — `config` / DefaultsTrackCurrentLineage  (ALREADY SATISFIED in `main`)

- [x] `DEFAULT_ANTHROPIC_MODEL` is `claude-sonnet-4-6` (matches the runtime config default) — no drift.
- [x] `mcp-tool-count-doc.test.ts` already guards the documented tool count against `TOOL_DEFINITIONS`.
- [ ] (Optional follow-up) A language-count drift guard, if/when a doc states a hard language count.

## Remaining slices (not started — each independently shippable)

- [ ] `mcp-handlers` / ReadyOrHonestFirstUse — not-ready conclusion / self-bootstrap instead of silent empty.
- [ ] `mcp-quality` / DefaultSurfaceRevealsAllFaces — run the substrate-vs-navigation benchmark; flip default.
- [ ] `mcp-quality` / ProgressiveCatalogDisclosure — adopt Tool Search / `defer_loading` where supported.
- [ ] `mcp-quality` / ConsistentToolNaming — reconcile names with permanent aliases + a naming guard.
- [ ] `mcp-quality` / NoRedundantConclusions (prose) — sibling "use X instead" in description prose.
- [ ] `mcp-handlers` / ConciseByDefaultDetailedOnRequest — `responseFormat` + truncation receipts.
- [ ] `cli` / TruthfulDoctorExitCodes — exit 0 on the no-LLM happy path; minor-version Node guard.
- [ ] `cli` / GuaranteedIndexAtFirstSession — surface skipped/failed build with its one remediation.
- [ ] `cli` / CommandSurfaceGroupedByJob — group `openlore --help` by job; mark experimental suites.
- [ ] `overview` / DocumentationSingleSourceOfTruth — one canonical page per concept; task→doc index.

## Verification (Slice 1)

- [x] `npm run build` clean.
- [x] `vitest run src examples` green.
- [ ] `openspec validate refine-happy-path-and-defaults` (run at archive time).

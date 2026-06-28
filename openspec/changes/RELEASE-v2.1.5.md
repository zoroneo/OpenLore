# Release v2.1.5 (from v2.1.4)

**Happy-path polish + the benchmark-cleared `substrate` default** — PR #218, change
`refine-happy-path-and-defaults`. Staged by a `chore(release)` bump of `package.json` +
`package-lock.json` to `2.1.5`; the release workflow's tag↔version guard then validates the `v2.1.5`
tag, runs lint/typecheck/tests, and publishes to npm. The runtime version is read from `package.json`
at startup, so `--version` and the `tools/list` banner track the bump automatically.

This release raises the *first-five-minutes / first-five-tool-calls* quality of OpenLore to the level
of its capability — opt-in features are discoverable, the CLI and tool surface are legible, first use is
honest, verbose output is economical — and flips the default MCP surface to the both-faces `substrate`
preset on benchmark evidence.

Everything is **additive and backward-compatible** — no tool, command, preset, language, or capability
removed; no required config added; deterministic and local-first (no LLM in any serving path), per the
north-star decision `c6d1ad07`. The two behavior changes each ship with a one-flag/one-param escape.

> **Tool surface:** **72 tools**, 6 capability families. The **default MCP surface changed** this
> release — it is now the **13-tool `substrate`** preset (both faces), flipped from the 10-tool
> `navigation` preset on benchmark evidence. `--preset navigation` is the lean escape; `--preset full`
> still wires all 72.

---

## 1. The default MCP surface is now `substrate` (both faces) — benchmark-cleared

A default `openlore install` / bare `openlore mcp` now wires the **`substrate`** preset: the navigation
graph-traversal core **plus** the three highest-value governance reads (`recall`, `verify_claim`,
`blast_radius`). The lean `navigation` default under-sold the substrate — an agent installed the
documented way never discovered those reads.

The flip cleared the full `DefaultSurfaceRevealsAllFaces` gate, none of its quantities regressing:

- **Token economy** — substrate ~4.5k tokens, +1.2k over navigation, within the ~10k tool-search
  threshold (`npm run bench:surface`).
- **Face coverage** — substrate exposes navigate + change + remember + verify; navigation only navigate
  (CI-guarded).
- **Selection accuracy** — substrate 90% vs navigation 80% on shared tool selection (no regression),
  100% vs 0% on governance tasks (`npm run bench:selection`, Claude Code CLI, 2 passes).
- **Task completion** — across **two models** (sonnet + the weaker haiku) and **both repo tiers**, 100%
  correctness everywhere, no regression, substrate cheaper on 3 of 4 model×tier cells
  (`npm run bench:completion`).

Recorded as decision `c79ec7ca` / **ADR-0023, superseding ADR-0022**. **Escape:** `--preset navigation`
restores the lean navigate-only core; `--preset full` wires all 72 tools.

## 2. Verbose tools are concise by default

`get_duplicate_report` and the four list inventories (`get_middleware_inventory`, `get_schema_inventory`,
`get_ui_component_inventory`, `get_env_vars`) now return a concise summary — totals + a sample + a
truncation receipt that names the fuller call — instead of the full payload. Measured **−87%**
(`get_duplicate_report`) and **−45%** (`get_env_vars`) on this repo; small inventories return in full
(no data lost). **Escape:** `responseFormat: "detailed"` returns the complete payload.

## 3. Discoverability & legibility

- **`openlore features`** — every opt-in feature, whether it is active, and the one command/snippet to
  enable it. Zero required config for core value. `--json`, `--inactive`.
- **Job-grouped `openlore --help`** — ~49 commands grouped by job, nothing hidden.
- **Structured ready-or-honest first use** — graph tools return `{ notReady, reason, remedy }` (or
  self-bootstrap) instead of a silently-empty result when the index is absent.
- **`docs/README.md` documentation index** — task → one canonical page; overlapping pages cross-link;
  stale pages redirect.

## 4. Consistent tool naming (with a permanent alias)

`get_ui_components` → `get_ui_component_inventory` (matches its `get_*_inventory` siblings). The prior
name keeps working forever as a deprecated **alias** — no caller breaks. A new `TOOL_NAME_ALIASES`
mechanism makes every future rename safe the same way.

## 5. Note — `ProgressiveCatalogDisclosure`

Satisfied by the shipped server-side design: the preset system (curated default + `--preset full`
escape) and per-tool `annotations.family`. Native `defer_loading` / Tool Search is a **client/API**
responsibility an MCP server cannot emit; the server-side `list_changed` alternative was considered and
**rejected** — mutating `tools/list` mid-session invalidates the prompt cache the requirement asks to
preserve. Building it would overstep OpenLore's bounds as deterministic, local-first plumbing.

---

## Upgrade notes

- **No breaking changes.** No tool, command, preset, language, or capability was removed; no required
  config was added.
- If you want the **prior lean default surface**, wire `--preset navigation` (install/connect/mcp).
- If a tool's output is now a **concise summary** and you need the full payload, pass
  `responseFormat: "detailed"`.
- The old tool name `get_ui_components` still works (permanent alias).

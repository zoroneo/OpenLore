# Changelog

All notable changes to OpenLore are documented here. This project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`openlore review` — deterministic structural PR review (#188).** A new no-LLM CLI
  command that composes the structural delta (`structural_diff`: removed/added/
  signature-changed symbols + the callers they leave stale) and the blast radius
  (`computeBlastRadius`: hubs, layers, tests to run, and the spec/memory/decision drift
  the change introduces) for a `base..head` range into one conclusion-shaped Markdown or
  JSON briefing. No new MCP tool, no new structural computation. Ships with a bundled
  GitHub Action (`.github/actions/openlore-review`) that posts it as a single sticky PR
  comment — created once, updated in place by a hidden marker, never duplicated — plus a
  copy-paste workflow. Advisory by default (exit 0); opt-in gating via the existing
  `blastRadius.block` convention. Degrades honestly (no index → structural delta only +
  "run `openlore analyze`"; non-git / unreachable base / unwritable `--out` disclosed,
  never a crash). The Action activates once a published `openlore` ships `review`.
- **OpenSpec plugin manifest (marketplace Phase 1)** — OpenLore is the inaugural
  OpenSpec marketplace plugin. It now ships a declarative plugin manifest (the
  `"openspec"` key in `package.json`, vendored schema
  `schemas/openspec-plugin-manifest-v1.json`) that OpenSpec reads to discover,
  surface, gate, and invoke OpenLore as a subprocess without importing its code.
  New `openlore plugin-manifest emit|validate` inspects/validates it — named
  distinctly from the federation `openlore manifest` so the two never collide. The
  host loader and curated registry are built separately in the OpenSpec repo.
- **Task-scoped context injection** — `openlore install` now wires a Claude Code
  `UserPromptSubmit` hook running `openlore orient --inject`, which orients on your
  submitted prompt and injects a bounded, deterministic, ignorable orientation
  block *before the agent's first turn* — amortizing the per-task `orient`
  round-trip the Value Scorecard attributes the small/familiar loss case to. A
  deterministic relevance gate keeps it out of weak/shallow tasks (degrading to a
  one-line pointer); it is fail-open (never breaks a turn) and reuses the lean
  `orient` output (no new MCP tool). Disable or tune via the `contextInjection`
  block in `.openlore/config.json` (`mode: "off"`, `tokenBudget`, gate thresholds).
  Adapters without a pre-turn hook (Cursor/Cline/Continue/AGENTS.md) fall back to
  the instruction block (#184).

### Changed

- **CLI front door now describes the product and steers to one-command setup.**
  Bare `openlore` / `openlore --help` previously opened with the legacy spec-gen
  framing ("Reverse-engineer OpenSpec specifications…") and a Quick start that sent
  new users to `openlore generate` (LLM/API-key-gated). The program description now
  reads "Persistent architectural memory for coding agents" (served via `orient` +
  MCP), the `--help` epilog leads with "Get started (one command): `openlore install`"
  and groups commands into no-API-key **Core** vs optional **Spec authoring**, the
  stale `test` line now reads "Report spec test coverage" (it never generated tests),
  and `openlore doctor` recommends `openlore install` when config/analysis is missing.
  `openlore install` and `openlore doctor` are documented in the CLI reference (#188).

- **The default MCP tool surface is now lean (behavior change).** A bare
  `openlore mcp` and a plain `openlore install` now wire the 10-tool `navigation`
  preset — the Spec 14 benchmark-winning graph-traversal core — instead of all 62
  tools. Schemas for tools the agent never calls are pure per-request overhead, so
  breadth is now opt-in. The full 62-tool surface is one explicit selector away:
  `openlore mcp --preset full` / `--all-tools`, or `openlore install --preset full`.
  No tool was removed; every capability stays reachable via its named preset
  (`minimal`, `memory`, `verify`, `federation`, `full`). When the lean default is
  active, the server advertises the opt-in once through the MCP `initialize`
  `instructions` channel (zero extra tool schemas). `openlore serve` now also
  accepts `full` as an alias of `all`, and `openlore install` / `connect` accept
  `--all-tools` (#185).

  **Migration — repos that gate commits.** The lean default does **not** include the
  governance tools the decisions pre-commit gate uses (`record_decision`,
  `check_spec_drift`, `detect_changes`). If you rely on that workflow, re-install
  with `openlore install --preset full` (all 62) or `--preset minimal` (the
  governance core) to wire them back.
- **Config-key ownership** — when OpenSpec owns `openspec/config.yaml`, OpenLore now
  writes only its `openlore` key and preserves every other key and comment
  byte-for-byte (a top-level-block string splice that keeps CRLF line endings,
  inline-comment spacing, and folded scalars intact); it refuses to overwrite a
  malformed host config rather than risk clobbering it.

### Fixed

- **Incremental watch now converges with `analyze --force` (substrate correctness).**
  With `--watch-auto`, each save re-resolves the changed file's reverse-dependency
  closure — its direct callers (no longer capped at 10) plus prior non-callers whose
  previously-unresolved calls a newly-added symbol now binds — so the affected call
  graph matches a full re-analyze instead of silently diverging (it was depth-1 only:
  `A→B→C`, edit `C`, callers past the first 10 and newly-resolvable non-callers stayed
  stale until the next `analyze --force`). A bounded per-save work budget
  (`INCREMENTAL_CLOSURE_BUDGET`, default 40) keeps a hub edit light; over-budget or
  unreadable files are marked **explicitly stale** in the graph metadata (freshness
  verdicts over their symbols report non-authoritative, never silently wrong) and
  self-heal as later edits touch them. A full `openlore analyze --force` clears the
  region. Name resolution for duplicate simple names is now deterministic
  (seed-order-independent), so incremental and from-scratch builds agree. The
  call-graph store gains an additive `edges(callee_name)` index (keeps the new
  closure lookups sub-millisecond instead of full table scans) and a
  `busy_timeout` (a watcher save and a concurrent `analyze --force` no longer
  throw `database is locked`). A stale-region freshness downgrade is now labeled
  distinctly (`staleRegion`) and the drift detector no longer reports it as a
  code change — the anchored code is byte-identical and it self-heals.
- **Node-version guard** — launching the CLI under an unsupported Node (<22.5) now
  fails fast with one legible stderr line and the stable exit code 78 (never a
  stack trace), protecting subprocess delegation from a host on Node 20/21. The
  guard runs from a bootstrap module so it evaluates before commander loads.
- **`--json` stream purity** — `verify --json` (and, defensively, `drift`/`decisions`
  `--json`) now keep stdout pure: machine output on stdout, all logs on stderr.
- **`openlore install --no-analyze` next-step** — it skips `init` as well as
  `analyze`, so the old advice "Run `openlore analyze`" failed with "Run `openlore
  init` first." It now advises `openlore init && openlore analyze` (or `openlore
  install` to do it in one step) (#188).
- **No-key error surfaces the `claude-code` provider** — `generate` / `run` without an
  API key previously told the user only to set `ANTHROPIC_API_KEY`/etc., never
  mentioning that the Claude Code CLI (which `openlore doctor` detects) is a no-key
  provider. The error now points to `generation.provider: "claude-code"` (#188).

## [2.1.3] - 2026-06-22

Everything merged since v2.1.2: a batch of new agent-facing capabilities plus a
deep end-to-end hardening and dogfooding pass. The version is read from
`package.json`, so the CLI and the MCP server both report `2.1.3`.

### Added

- **Agent behavioral governance ("panic")** — opt-in, off by default (#175). A
  PreToolUse destabilization guard (`openlore panic-check`), an observe→memory
  feedback loop that feeds behavioral hotspots into `orient`, an optional Gryph
  runtime observer, and an accuracy-validation harness
  (`panic-validate` / `panic-calibrate` / `panic-replay`). Enable per project with
  `openlore setup --panic <mode>` and install the hooks with
  `openlore setup --hooks <format>` (remove them with `--hooks none`).
- **External spec-store binding** — the `spec_store_status` MCP tool (federation
  preset) reports the read-only health of a `.openlore/config.json` `specStore`
  binding and its indexed targets (#178).
- **Working-set context briefing** — the `working_set_context` MCP tool assembles
  one token-budgeted, per-target structural briefing for an active change across
  its spec-store targets (#180).
- **Change-impact certificate** — the `change_impact_certificate` MCP tool and the
  `openlore impact-certificate` CLI certify what a diff touches: the paths it
  newly opens into declared covering surfaces (differential, no LLM), blast
  radius, drifted specs, and the tests to run (#181).
- **Live dependency graph in watch mode** — `watch` now reconciles file creates &
  deletes and keeps `dependency-graph.json` import edges (including inline
  `<script>` and HTML asset edges) fresh incrementally (#173).
- **Pi extension** — marketplace gallery preview image (#174); Windows daemon
  hardening so no console window flashes (#177).

### Changed

- Removed the `get_decisions` MCP tool. ADRs are now surfaced through
  `search_specs` (domain `decisions`) and via `orient`'s ADR matches, which now
  work without an embedding server (#179).
- `.mjs` / `.cjs` / `.mts` / `.cts` files are now recognized as JavaScript /
  TypeScript and included in the call graph and signature index (previously
  silently dropped).
- Panic-state: the on-disk file is the single source of truth for the
  cross-process intervention counter; all writers (MCP server, hook, daemon)
  serialize through one lock.
- Documentation: Windows setup steps in CONTRIBUTING (#176); corrected and guarded
  MCP tool-count references.

### Fixed

End-to-end hardening pass (PR #182), all with regression tests:

- **First run** — `openlore init` and `openlore run` now create `.gitignore` on a
  fresh `git init` repo, so `.openlore/` analysis artifacts (multi-MB lance
  binaries) aren't accidentally committed and don't pollute diff-based tools.
- **MCP no-throw / robustness** — `get_spec` confines its `domain` argument
  (path-traversal fix); `get_file_dependencies` guards a partial dependency-graph
  artifact; `change_impact_certificate` drops non-object surface members and
  `buildLeaseAnchors` never escapes the handler; a malformed `callGraph` is
  normalized instead of crashing graph handlers; large tool results stay valid
  JSON when capped to the byte budget.
- **LLM generation** — all providers tolerate malformed or `usage`-less responses
  (common with OpenAI-compatible gateways) instead of crashing or reporting `$NaN`
  cost.
- **Panic** — fixed a cross-process lost-update on the intervention counter;
  untrusted `panic-state.json` fields are sanitized and a NaN timestamp is treated
  as expired; panic hooks gained an uninstall path and update in place on a format
  change.
- **Multi-repo federation** — a registered repo that throws mid-query is skipped
  with a reason instead of aborting the whole fleet query; tool output no longer
  leaks absolute host paths.
- **CLI** — `verify --json` and `decisions --sync` now exit non-zero on failure
  (they previously reported failure but exited 0, defeating CI gates); `decisions`
  has a top-level error boundary; `openlore view` reports a friendly message on a
  port-in-use, sanitizes errors before logging, and serves a 404 (not 500) for a
  missing graph artifact.

**Full Changelog**: https://github.com/clay-good/OpenLore/compare/v2.1.2...v2.1.3

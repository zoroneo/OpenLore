# OpenLore Spec 26 — Install, MCP-Wiring & First-Run Correctness (Dogfood Findings)

> A fix-plan spec. **No code in this session** — investigation + solutions only. Sourced from
> dogfooding the published **v2.0.8** release across several real repos (verisim, nidus, …). Every
> finding below was re-confirmed against the actual code by a 10-agent investigation workflow with
> file:line evidence; all 10 came back **confirmed, high-confidence**. Parent:
> [Spec 13](openlore-spec-13-context-substrate.md). Sibling: [Spec 24](openlore-spec-24-post-arc-ci-hardening.md)
> (the earlier CI-hardening dogfood pass).

---

## Progress

Original plan branch: `chore/post-arc-ci-hardening` → [PR #120](https://github.com/clay-good/OpenLore/pull/120).
All implementation landed on `fix/spec-26-wave-0-mcp-registration` →
[PR #121](https://github.com/clay-good/OpenLore/pull/121). Status: **Waves 0–4 shipped.**

- [x] **Wave 0** — Fix MCP registration (the headline bug). B1: `openlore install --agent claude-code`
  now writes `mcpServers.openlore` to **`.mcp.json`** (the file Claude Code actually reads) and keeps
  only the SessionStart hook in `.claude/settings.json`; re-running migrates a legacy
  `settings.json` entry away. Added a `doctor` **MCP wiring** check that warns when the server is in
  the wrong file (with the exact `--force` fix).
- [x] **Wave 1** — Consolidated `doctor` pass. B4 (LLM/embedding = warn, not fail → no-LLM exits 0),
  B7-doctor (Node *minor*-version check ≥22.5 for node:sqlite), B5-doctor (read the configured
  openspecPath). Also fixed an audit-found layer-matching bug (`layerOf` substring → path-boundary).
- [x] **Wave 2** — Detection correctness. B5 (`detectExistingSpecDir` → point at docs/specs/ or
  specs/ instead of an empty openspec/; sharpened spec-index error), B6A (depth-1 nested-manifest
  scan), B6B (bias to claude-code when `~/.claude` exists instead of blind AGENTS.md).
- [x] **Wave 3** — Freshness ownership. B9 (removed the redundant full-`analyze` PostToolUse hook;
  `--watch-auto` is the sole owner; setup migrates the legacy hook away), B10 (watcher schedules one
  detached `analyze --force` to self-heal a schema-reset graph).
- [x] **Wave 4** — Cleanup. B8 (skill SKILL.md → real camelCase fields + `.mcp.json` detection note),
  B3 (`ARCHITECTURE.md` now lands in `.openlore/analysis/`; dropped the redundant gitignore line),
  B2a (gitignore parent-prefix guard, slash-insensitive), B2b (default model → `claude-sonnet-4-6`).

> **Deferred (low value, already mitigated):** B7's optional npx/`node:sqlite` import guards — the
> doctor minor-version check (Wave 1) + `engines.node` already catch a too-old Node. Audit findings
> in orient (`involvesRelevant`) and structural-diff (rename path) were investigated and judged
> **not bugs** (both endpoints are full file paths so `===` is the real match; labeling the old
> snapshot with the new path is intentional rename-matching).

---

## 0. The two dominant themes (read these first)

Everything below collapses to two root themes. Internalize them and most of the bugs are obvious:

- **Theme A — "settings.json = hooks, `.mcp.json` = mcpServers."** OpenLore writes its MCP server
  declaration to `.claude/settings.json`, which **Claude Code never reads for MCP**. The single most
  important fact in this spec. It spans the headline bug (B1), the skill's detection heuristic (B8),
  and the agent-detection layer (B6).
- **Theme B — silent degradation / false-positive health.** The tool repeatedly *looks* fine while
  being broken: MCP never loads (B1), an empty `openspec/` reports "✓" (B5), spec linking is silently
  empty (B5), the graph index silently empties on a version bump (B10), `doctor` calls an optional
  LLM dependency "fatal" (B4). **Fixing the *signal* is as valuable as fixing the behavior** — which
  is exactly why `doctor` (Theme C below) gets a consolidated pass: it's the funnel where all of this
  should have become visible.

---

## 1. Findings (confirmed, with root cause + deterministic fix)

Severity order. Each fix is **deterministic and offline** (OpenLore's north star). File:line cites
are from the investigation against `main` at v2.0.8.

### B1 · CRITICAL · MCP server written to the file Claude Code ignores
*Commands: install, setup, doctor, generate. Effort: M.*

**Root cause.** The claude-code adapter registers the server in `.claude/settings.json` under
`mcpServers.openlore` ([adapters/claude-code.ts:17-20, :112](../../src/cli/install/adapters/claude-code.ts)),
but Claude Code loads MCP only from **`.mcp.json`** (project), `~/.claude.json`, or `claude mcp add`
— never `settings.json`. `setup` calls `installClaudeHook`
([setup.ts:363-365](../../src/cli/commands/setup.ts) → [decisions.ts:339-359](../../src/cli/commands/decisions.ts))
which adds **only** a PostToolUse hook, never the server. `generate`/`doctor` don't register it at
all. **Net: after `openlore install` / `setup --tools claude`, `mcp__openlore__*` tools never load.**
The product's core value is silently dead on arrival. (Related: a malformed block written to
`settings.json` also triggered Claude Code's *"expected array, but received undefined … settings not
in effect"* — wiping the user's permissions too.)

**Fix.** (1) Write the MCP server to **`.mcp.json`** at project scope (git-tracked, auto-loaded),
merging via the existing managed-entry pattern in [json-managed.ts](../../src/cli/install/json-managed.ts).
(2) Keep the SessionStart hook in `settings.json` (correct, schema-valid). (3) Ensure **nothing**
written to `settings.json` violates its schema (the "expected array" report — audit the hooks/permissions
shape). (4) Add a `doctor` check: if `mcpServers.openlore` is in `settings.json` but absent from
`.mcp.json`, warn with the exact fix (`openlore install --agent claude-code --force`). (5) Update
[docs/mcp-tools.md](../../docs/mcp-tools.md) + [docs/agent-setup.md](../../docs/agent-setup.md).
*Files:* `adapters/claude-code.ts`, `doctor.ts`, the two docs. *Risk:* existing `settings.json`
`mcpServers.openlore` entries need cleanup — the new doctor check + `--force` is the migration path.

### B5 · HIGH · `init` creates an empty `openspec/` blind to existing specs
*Commands: init, analyze, doctor. Effort: M.*

**Root cause.** `init` unconditionally creates `openspec/specs/`
([init.ts:170-174](../../src/cli/commands/init.ts) → [config-manager.ts:163-166](../../src/core/services/config-manager.ts))
without detecting specs that already live in `docs/specs/` or `specs/`. Then `doctor` reports
"✓ OpenSpec directory" off the **empty** dir ([doctor.ts:145](../../src/cli/commands/doctor.ts), hardcoded
path), while `analyze` throws "No spec.md files found" internally
([spec-vector-index.ts:319-322](../../src/core/analyzer/spec-vector-index.ts)) and logs "Spec index
skipped" — so `linkedSpecs`/`specDomains`/drift are silently empty. A triple silent failure.

**Fix.** Add `detectExistingSpecDir()` (scan `openspec/specs/`, `docs/specs/`, `specs/` for `*.md`),
call it from `init` *before* `createOpenSpecStructure()`: if a non-empty dir is found, set
`openspecPath` to it and skip creating an empty one; if empty, warn. Make `doctor`'s OpenSpec check
read the **configured** `openspecPath`, not a hardcoded one. Sharpen the spec-index error to
distinguish "dir missing" from "dir empty" so `analyze` can warn about misconfig. *Files:*
`config-manager.ts`, `init.ts`, `api/init.ts`, `spec-vector-index.ts`, `analyze.ts`, `doctor.ts`.
*Load-bearing caveat (document it):* non-OpenSpec-format `spec.md` files still won't *link* even after
detection points at them — detection only fixes the silent false-positive, not the format gap.

### B6 · HIGH · Detection is root-only and has no Claude-Code bias
*Commands: install, init, analyze. Effort: M.*

**Root cause.** (A) Project-type detection only checks manifests at the repo root
([project-detector.ts:49-68](../../src/core/services/project-detector.ts)) → a nested
`python/pyproject.toml` (nidus) yields "Unknown". (B) Agent detection walks up for markers
(`.claude/`, `CLAUDE.md`, …) and, finding none, **unconditionally** falls back to `agents-md`
([detect.ts:116-119](../../src/cli/install/detect.ts), [install/index.ts:113-126](../../src/cli/install/index.ts))
— so a Claude Code user with a clean repo is silently mis-targeted. Bad for the headline audience.

**Fix.** (A) Scan a small set of depth-1 subdirs (`python/`, `src/`, `backend/`, `frontend/`, …)
before declaring "Unknown"; prefer the shallowest match. (B) Replace the blind `agents-md` fallback:
check `~/.claude/`; if present, bias to `claude-code`; else, on a TTY prompt to choose, and only
fall back to `agents-md` non-interactively with an explicit warning + "run with `--agent claude-code`".
*Files:* `project-detector.ts`, `detect.ts`, `install/index.ts`. *Risk:* `~/.claude` is a new implicit
dependency; keep prompts TTY-only so CI isn't surprised.

### B7 · HIGH · Node `>=22.5.0` vs repo `.nvmrc` 20 — latent session-start breakage
*Commands: install, mcp, orient. Effort: M.*

**Root cause.** `engines.node >=22.5.0` ([package.json](../../package.json)) is required by
`node:sqlite`/`DatabaseSync` ([edge-store.ts:3](../../src/core/services/edge-store.ts),
[epistemic-lease.ts:30](../../src/core/services/mcp-handlers/epistemic-lease.ts), loaded at mcp.ts
module-load). The MCP server and SessionStart hook shell out via `npx`
([adapters/claude-code.ts:18-28](../../src/cli/install/adapters/claude-code.ts)); when a shell honors
a repo `.nvmrc` pinned to Node 20 (nvm auto-switch), both fail cryptically. `doctor` only checks
major-version ≥20 ([constants.ts:226](../../src/constants.ts) `MIN_NODE_MAJOR_VERSION = 20`), so it
doesn't catch it. Works today only because the active node happens to be 25.x.

**Fix (recommended = lock + warn, not lower the floor).** Keep `>=22.5.0` (the EdgeStore refactor
deliberately moved off `better-sqlite3`; `node:sqlite` is RC as of Node 25.7). (1) `doctor` checks the
**minor** version (≥22.5), failing fast with a `nvm use` remediation. (2) Wrap the generated npx
invocations with a one-line node-version guard that prints a clear error instead of a module crash.
(3) A try/catch around the `node:sqlite` import surfacing an actionable preflight message. *Files:*
`package.json` (doc the why), the adapters, `doctor.ts`, `mcp.ts`, `orient.ts`. *Open decision:* whether
to ever support Node 20 by feature-gating `node:sqlite` — recommend **no** (keep the floor, fix the
signal).

### B10 · HIGH · Version bump silently resets the graph index, no auto-rebuild
*Commands: orient, analyze_codebase, MCP read paths. Effort: M.*

**Root cause.** On a `SCHEMA_VERSION` bump ([edge-store.ts:51, :74](../../src/core/services/edge-store.ts))
the store wipes graph tables and sets `_wasReset`. `readCachedContext` correctly withholds the empty
store ([utils.ts:181](../../src/core/services/mcp-handlers/utils.ts)) and `orient` emits a
`graphIndexNote` ([orient.ts:544, :553](../../src/core/services/mcp-handlers/orient.ts)) — but **no
rebuild is triggered**; the watcher explicitly skips on `wasReset`
([mcp-watcher.ts:363-368](../../src/core/services/mcp-watcher.ts)). Callers, call-paths, and insertion
points are degraded until a manual `analyze`. (The note we added earlier mitigates *silence*; the
finding is it should *self-heal*.)

**Fix (recommended = watcher auto-rebuild).** When `handleBatch` sees `wasReset`, schedule **one**
background `openlore analyze --force` (no-watch, session-global in-progress flag to avoid a thundering
herd; log to stderr). Reset the flag on completion; on failure, fall back to the existing note (no
infinite loop). *Files:* `mcp-watcher.ts`, `utils.ts`, `orient.ts`. *Sequence:* land **after** B9 so
the watcher is the unambiguous freshness owner first. *Risk:* rebuild CPU during large repos — gate
with the session flag + once-per-bump.

### B4 · MEDIUM · `doctor` exits non-zero solely on the optional LLM/embedding check
*Commands: doctor (perceived health of analyze/orient/search/mcp). Effort: S.*

**Root cause.** `doctor` runs 8 checks — 6 deterministic + 2 LLM/embedding — and treats **any**
`fail` as fatal: `process.exitCode = 1`, "X check(s) failed — fix before proceeding"
([doctor.ts:440-450](../../src/cli/commands/doctor.ts)). The LLM/embedding checks return `fail` (never
`warn`) when a key is absent ([doctor.ts:232-238, :262-318](../../src/cli/commands/doctor.ts)) — even
though the entire deterministic workflow (`analyze --no-embed` + `orient`/`search` via BM25) needs
**no** LLM. This contradicts the "No API Key" docs and the BM25-fallback design.

**Fix (Approach A — recommended).** Make the LLM/embedding checks **`warn`, not `fail`**
(doctor.ts:246, :295). Warnings already don't set `exitCode=1` (doctor.ts:446-447), so the no-LLM path
exits 0 while still surfacing the advice. Reword the summary to "X failed, Y warnings" when both
present. (Optional `--offline` flag = Approach B, more surface; A is the 2-line, more-honest fix.)
*Files:* `doctor.ts`. *Risk:* scripts that asserted non-zero on missing-LLM now see 0 (acceptable; use
`--json` for scripting).

### B9 · MEDIUM · Redundant freshness: PostToolUse full-`analyze` vs `--watch-auto`
*Commands: setup, mcp, decisions. Effort: S.*

**Root cause.** The PostToolUse hook runs a **full O(repo)** `openlore analyze`
([decisions.ts:334](../../src/cli/commands/decisions.ts)) on every tool call, while the MCP server's
`--watch-auto` (default since v2.0.6/Spec 13.1, [mcp.ts:1848](../../src/cli/commands/mcp.ts)) already
keeps freshness **incrementally O(change)** ([mcp-watcher.ts](../../src/core/services/mcp-watcher.ts)).
Double work. The hook's `_comment` ("after every file edit", [decisions.ts:328](../../src/cli/commands/decisions.ts))
is also wrong — PostToolUse fires for **all** tools (Read, Bash, …), masked only by a 10s lock.

**Fix.** Declare `--watch-auto` the single freshness owner: **remove** the full-`analyze`
`ANALYZE_HOOK_ENTRY` from `installClaudeHook`/`uninstallClaudeHook`. (If a post-call hook is wanted for
other reasons, make it strictly lighter and fix the `_comment` to say it fires on every tool call.)
*Files:* `decisions.ts`. *Risk:* verify no test/doc treats the hook as a required freshness contract
before removal. *Sequence:* before B10.

### B8 · MEDIUM · `openlore-orient` skill: stale schema + wrong MCP-detection
*Commands: orient. Effort: S (docs-only).*

**Root cause.** [skills/openlore-orient/SKILL.md:40-43](../../skills/openlore-orient/SKILL.md) tells
agents to parse **snake_case** (`relevant_functions`, `spec_sections`, `insertion_points`, `callers`),
but `orient --json` emits **camelCase** ([orient.ts:546-570](../../src/core/services/mcp-handlers/orient.ts):
`relevantFunctions`, `relevantFiles`, `specDomains`, `callPaths`, `insertionPoints`). Its MCP-detection
note (SKILL.md:28) only mentions `.claude/settings.json → mcpServers.openlore` (the wrong file per B1).

**Fix.** Update SKILL.md to the real camelCase field names; fix the detection note to point at
`.mcp.json` (after B1 lands). The "CLI subcommand not yet shipped" TODO is already corrected in this
file — confirm it stays accurate (it ships in 2.0.8). *Files:* `skills/openlore-orient/SKILL.md`.
*Sequence:* the `.mcp.json` half lands **after** B1; the camelCase half is independent.

### B3 · MEDIUM · `ARCHITECTURE.md` written to repo root, not gitignored
*Commands: analyze. Effort: S.*

**Root cause.** `writeArchitectureMd()` writes to `join(rootPath, 'ARCHITECTURE.md')`
([architecture-writer.ts:271](../../src/core/analyzer/architecture-writer.ts)); the call site passes
only `rootPath` ([analyze.ts:605-614](../../src/cli/commands/analyze.ts)). Every *other* artifact
(CODEBASE.md, SUMMARY.md) writes under `.openlore/analysis/`
([codebase-digest.ts:74-78](../../src/core/analyzer/codebase-digest.ts)). So `ARCHITECTURE.md` churns
in `git status` at the repo root (worsened by the freshness hook re-running analyze), and `init`'s
gitignore only covers `.openlore/`.

**Fix (recommended = move it, don't gitignore it).** Give `writeArchitectureMd(outputDir, overview)`
and pass `outputPath` (already `join(rootPath, opts.output)` at analyze.ts:346), so it lands in
`.openlore/analysis/` with the rest. Update the test assertion. Cleaner than adding a gitignore line —
one gitignored home for all generated analysis. *Files:* `architecture-writer.ts`, `analyze.ts`,
`architecture-writer.test.ts`. *Risk:* one-time manual cleanup of stray root `ARCHITECTURE.md`.

### B2a · LOW · Redundant `.gitignore` child entry
*Commands: init, setup, decisions. Effort: S.*

**Root cause.** `ensureGitignored()` only matches an exact line
([decisions.ts:179-188](../../src/cli/commands/decisions.ts)) and appends `.openlore/decisions/`
([decisions.ts:247](../../src/cli/commands/decisions.ts)) even though `init` already added the covering
`.openlore/`.

**Fix.** Before appending `a/b/c/`, skip if an existing entry is a covering parent (`a/`, `a/b/`) with
trailing-slash normalization. Guard against false parents (`.openlore` must not match `.openapi/`).
*Files:* `decisions.ts`.

### B2b · LOW · Stale default generation model
*Commands: init. Effort: S.*

**Root cause.** `DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-4-20250514'`
([constants.ts:213](../../src/constants.ts)), used by `getDefaultConfig()`
([config-manager.ts:65](../../src/core/services/config-manager.ts)).

**Fix.** Bump to **`claude-sonnet-4-6`** (Sonnet 4.6 — **confirmed current** in the live model lineup).
Update the hard-coded expectations in `config-manager.test.ts`, `generate.test.ts`, `run.test.ts`.
Verify the `llm-service.ts` pricing table has a matching/version-agnostic `claude-sonnet-4` key so cost
estimation still resolves. *Files:* `constants.ts` + those tests.

### Non-bugs (credit, recorded so we don't "fix" them)
- **`orient --json` stream separation is correct** — pure JSON on stdout, diagnostics on stderr. A
  user's parse failure was self-inflicted (`2>&1`). 👍 Do not change.
- **Semantic search defaulting to BM25** when no `EMBED_BASE_URL`/`EMBED_MODEL` is **by design** and
  clearly messaged. Not a bug.

---

## 2. Cross-cutting themes (beyond §0)

- **Theme C — `doctor` is under-powered and mis-calibrated.** It appears in five findings (B1 wants a
  new "wrong-file" check, B5 a config-path-aware OpenSpec check, B7 a minor-version check, B4
  warn-not-fail). It's the natural funnel for Theme B's silent failures → it earns a **single
  consolidated pass** (Wave 1) instead of four colliding edits to `doctor.ts`.
- **Theme D — detection is too literal / root-only.** Root-only manifest scan (B6A), no-bias agent
  fallback (B6B), hardcoded spec-dir path (B5). All "look in exactly one place, assume the happy path."

## 3. Conflicts & ordering dependencies

1. **B1 → B8.** The skill's `.mcp.json` detection fix only makes sense once B1 makes `.mcp.json`
   canonical. (B8's camelCase half is independent.)
2. **`doctor.ts` is edited by B1, B4, B5, B7 — do one coordinated pass** (Wave 1) to avoid a four-way
   collision.
3. **B1 → B6.** Both touch the install/adapter layer; land B1 so the claude-code adapter is correct
   before B6 routes more cases to it.
4. **B1 → B7.** Both edit `claude-code.ts` (`MCP_ENTRY`/`ORIENT_COMMAND`); sequence so B7's node guard
   isn't rebased onto a moved entry.
5. **B9 → B10.** B9 makes `--watch-auto` the unambiguous freshness owner; B10 then gives that watcher
   the auto-rebuild duty. Compatible and mutually reinforcing, but order matters.
6. **B9 & B2a share `decisions.ts`** (different functions) — trivial to coordinate.

## 4. Recommended fix sequence (execution order)

- **Wave 0 — Ship the headline fix, alone, verified on a clean repo.** B1 (`.mcp.json` registration +
  doctor migration check). Without it the product's core promise is dead on arrival; it also unblocks
  B8/B6/B7.
- **Wave 1 — One consolidated `doctor` PR.** B4 (warn-not-fail) + B1's wrong-file check + B7's minor-
  version check + B5's config-path-aware OpenSpec check. Cheap, high signal, makes the tool's own
  diagnostics honest (which is how these would've been caught).
- **Wave 2 — Detection correctness.** B5 (spec-dir detection), B6 (nested manifest + Claude-Code bias),
  B7 (the adapter npx guards; the doctor minor-version check already shipped in Wave 1).
- **Wave 3 — Freshness ownership.** B9 (remove redundant hook) → B10 (watcher auto-rebuild on reset).
- **Wave 4 — Cosmetic/cleanup, batch anytime.** B8 (skill camelCase now; `.mcp.json` note after B1),
  B3 (move `ARCHITECTURE.md`), B2a (gitignore parent-guard), B2b (model bump).

## 5. Acceptance

- A **clean-repo dogfood** of `openlore install --agent claude-code` produces a **working** server:
  `claude mcp get openlore` → Connected; `mcp__openlore__*` tools available; nothing breaks
  `settings.json` parsing.
- `openlore doctor` on a no-LLM project exits **0** (LLM/embedding as warnings), and **catches** the
  wrong-file MCP wiring, a too-old node, and a misconfigured spec dir.
- `openlore init` on a repo with `docs/specs/` does **not** silently create an empty `openspec/`;
  detection + doctor agree on reality.
- After a version bump, the first MCP session **self-heals** the graph index (background rebuild)
  rather than degrading until a manual `analyze`.
- `analyze` writes **no** files to the repo root; `ARCHITECTURE.md` lives under `.openlore/analysis/`.
- All fixes are **deterministic and offline**; the skill docs match the real `orient --json` schema.

## 6. Non-goals

- No new runtime behavior beyond making install/first-run **work and tell the truth**.
- Do **not** lower the Node floor to support 20 (keep `node:sqlite`; fix the *signal* instead).
- No LLM/network in any fix (model-id bump is a default-string change, not a runtime dependency).

---

## 7. Full-surface verification (specs 1–26)

A final methodical pass on `2026-06-03` confirming every shipped spec is complete **and functionally
working**, not just unit-green. No code changed in this pass.

**Deterministic gates:** `lint` clean · `typecheck` clean · `build` clean · **3104 tests pass**, 2
skipped (145 files).

**Live MCP surface (driven over stdio against this repo):** `initialize` negotiates protocol
`2025-11-25`; `tools/list` returns **50 tools**, each with a schema (specs 11/12). A 25-call battery
of the headline read tools returned **25/25 OK, zero `isError`**:

| Spec | Tool | Evidence |
|------|------|----------|
| 06/13 | `orient` | returns ranked functions via `bm25_fallback` |
| 13 | `search_code` / `search_unified` | hits returned |
| 17 | `analyze_impact` | impact set for `readOpenLoreConfig` |
| 18 | provenance | `orient` surfaces last author/PR per file |
| 19 | `select_tests` | reachable tests for changed symbols |
| 20 | `find_dead_code` | swept 1,575 functions |
| 21 | `structural_diff` | base/head delta computed |
| 22 | `get_change_coupling` | volatility + co-change from git |
| 23 | `check_architecture` | scan mode (no rules → clean); 55 unit tests incl. the layer-boundary regression |
| 15/16 | `get_decisions` | the synced `e3d3214e` decision is a graph node |
| drift | `check_spec_drift` · `audit_spec_coverage` | run clean |

**CLI-only surfaces:** `preflight` (spec 03) exits 0; `export scip` (spec 04) emits a 641 KB SCIP
index; `manifest emit` + `validate` (spec 05) round-trip as a valid v1 manifest.

**Confirmed-intentional deferrals (behave correctly, never crash):** spec 04 SCIP import + column
ranges, spec 05 federation index + events/RPC extraction, spec 08 deferred languages, spec 09
(*NOT DOING — superseded*). Each emits empty arrays / a documented warning rather than wrong data.

**Conclusion: specs 1–26 are complete and fully working.** The only confirmed defect found across the
whole audit was the `layerOf` substring bug (fixed in Wave 1); two other reported findings were
investigated and judged not-bugs.

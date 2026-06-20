# Release v2.1.2 (from v2.1.1)

Analyzer-reach release: OpenLore now indexes web front-end surfaces it previously skipped — inline
`<script>` JS, HTML→asset dependency links, and literal strings the symbol graph can't hold. All
changes are **additive and backward-compatible** — no breaking changes to tools, schemas, or stored
data; callers that ignore the new fields/modes see prior behavior. Every new capability is
deterministic and local-first (no LLM in any serving path), per the north-star decision `c6d1ad07`.

Integration point for everything since the `v2.1.1` tag — PRs #169–#172. Staged by a `chore(release)`
bump of `package.json` + `package-lock.json` to `2.1.2`; the release workflow's tag↔version guard
(`.github/workflows/release.yml`) then validates the `v2.1.2` tag, runs lint/typecheck/tests, and
publishes to npm. The runtime version is read from `package.json` at startup (`src/cli/index.ts`), so
`--version` and the `tools/list` banner track the bump automatically.

> **Tool surface:** unchanged at **60 tools**. #170 *extends* `search_code` (a `mode: 'text'` plus a
> zero-hit fallback) rather than adding a tool, so `TOOL_DEFINITIONS.length` stays 60 and the
> doc-count guard from #169 continues to hold.

## Analyzer & search reach

### 1. Literal-text search index — `add-literal-text-search-index` (#170)
A separate **BM25-only line index** (LanceDB `text_lines.lance`), distinct from the symbol /
call-graph / signature index, for the literal strings symbols can't hold (config keys, route paths,
error messages, template text). `search_code` gains an explicit `mode: 'text'` and a **zero-hit
fallback**: when a symbol-mode query returns nothing, the handler consults the literal-text index and
returns `filePath` + `lineNumber` + line text. The index updates **incrementally** when watched files
change. BM25-only — no embeddings, no network.

### 2. Inline `<script>` JS into the call graph — `add-inline-script-call-graph` (#171)
Inline `<script>` blocks in HTML are extracted (`html-script-extractor.ts`) and indexed into the call
graph as first-class functions/edges, giving structural reach into front-end code that previously was
invisible to `orient`, `get_subgraph`, and impact analysis. Verified through the real analyze pipeline
(`html-inline-script.e2e.integration.test.ts`).

### 3. HTML → external JS/CSS dependency edges — `add-html-asset-dependency-edges` (#172)
HTML files are linked to their external `<script src>` / `<link href>` assets as dependency-graph
edges (`dependency-graph.ts`, `import-parser.ts`), so the file-dependency view and impact analysis
follow an HTML entry point out to the JS/CSS it loads.

## Docs & CI hardening

### 4. MCP tool-count drift fix + guard — `DOGFOOD-v2.1.1-tool-count-drift` (#169)
Corrected two stale current-tense "N tools" claims (`openspec/specs/cli/spec.md` 45→60,
`docs/governance-dogfooding.md` 50→60) that the existing doc-count guard didn't cover, and widened
`GUARDED_DOCS` in `mcp-tool-count-doc.test.ts` to pin both to `TOOL_DEFINITIONS.length`. Surfaced by a
published-`2.1.1` first-run e2e dogfood (recorded in the same change note), which otherwise found the
runtime solid across install/merge/uninstall, `orient`/`analyze`/watcher, MCP stdio + presets, and the
LLM (claude-code provider), embedding, graph, federation, and governance-gate paths.

## Verification

- **Combined-merge integration test:** all four PRs merged onto `origin/main` with **zero conflicts**
  (no file overlap); combined `build` + `typecheck` clean; **`npm run test:run`: 205 files, 4160
  passed / 2 skipped / 0 failed.** The cross-PR risk — #170 editing the tool registry vs #169's
  count guard — was checked and holds (surface stays 60).
- Per-PR CI was green on each (Build, Lint & Type Check, Unit Tests) before merge.

## Notable non-goals / deferred (unchanged from v2.1.1)

`add-lean-default-tool-surface` (the lean default MCP preset) remains **gated pending second-contributor
review** — the only backlog proposal not yet built. Embedding-backed recall, remote/global federation
registries, and inter-procedural data-flow stay deferred behind their own proposals.

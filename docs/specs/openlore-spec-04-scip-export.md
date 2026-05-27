# OpenLore Spec 04 — SCIP Export (Interop with Sourcegraph / Glean Ecosystem)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Progress

Branch: `openlore-spec-04-scip-export`. Export-only shipped; import deferred per scope.

- [x] Vendor pinned SCIP proto (`src/core/scip/vendor/scip.proto`) + add `protobufjs` runtime dep
- [x] Core module: `schema.ts` (proto load), `moniker.ts` (symbol/language derivation), `index.ts` (`exportScip(graph, options): Buffer`)
- [x] CLI: `openlore export scip [--out --project-root --include --exclude]` (`src/cli/export/`, registered in `src/cli/index.ts`)
- [x] Glob filtering (small in-house matcher; dropped `ignore` dep over a NodeNext typing quirk)
- [x] Fail-loudly when a node lacks a defining line; zero-width col-0 ranges + one-time warning otherwise (`TODO(spec-04-followup): column ranges in analyzer`)
- [x] Tests + 3-file fixture (`src/core/scip/` — tests are co-located per repo convention; `test/` is gitignored): round-trip parse, byte-determinism (SHA-256), exact counts (3 docs / 4 symbols / 8 occurrences / 4 definitions), include/exclude, external-node exclusion, missing-range throw
- [x] Docs: `docs/scip-export.md` + README "Interop" section
- [x] `lint`, `typecheck`, `test:run` (2789 pass), `build` (proto copied to dist; built CLI verified) all green — incl. CI fix: exclude `src/core/scip/fixtures/**` from ESLint typed-linting (fixtures are excluded from tsconfig, so `parserOptions.project` couldn't resolve them)

**In-scope spec is 100% complete.** PR #89 is mergeable and self-contained as a SCIP *export*. Downstream-impact review passed: vendored proto ships in the npm package (`dist/core/scip/vendor/scip.proto`, 33.7kB — no runtime `ENOENT`), fixtures/test files are excluded from the package, `protobufjs` adds ~7ms load + one transitive dep (`long`), and no graph-schema/MCP/`orient` surfaces were touched.

### Deferred follow-ups (NOT in this PR — documented for a later session)

Both were explicitly fenced off by this spec ("Out of scope for this PR"). They are paused by owner decision (2026-05-27); capturing the analysis here so a future session can pick them up without re-deriving it.

1. **`column ranges in analyzer`** — today the analyzer records line numbers but not columns, so SCIP occurrences are emitted as zero-width ranges at column 0 (with a one-time warning). Making them faithful requires:
   - Definitions: derivable now — `FunctionNode.startIndex` is a byte offset and the builder already holds file contents, so `column = startIndex − lastNewlineBefore(startIndex)`.
   - Call sites: NOT free — `RawEdge` carries only `line`; the AST walk in [call-graph.ts](../../src/core/analyzer/call-graph.ts) would need to capture each call expression's start column and thread it through to `CallEdge`.
   - **Tension to resolve:** this adds column fields to `FunctionNode`/`CallEdge`, i.e. it *changes the internal graph schema* — exactly what this spec's scope contract said the PR must NOT do, and it touches the repo's highest-fan-out hub (regression risk across all 7 languages). Recommend doing it as its own spec/PR with additive optional fields and per-language tests. The exporter already falls back gracefully, so this is a fidelity upgrade, not a fix.

2. **`scip import`** — consume an external `index.scip` into a "read-only OpenLore view." Underspecified; two interpretations surfaced:
   - *Light:* `openlore import scip <file>` parses an index and prints/returns a summary (documents, symbols, occurrences, sample monikers). Self-contained, no writes to the canonical graph, round-trip-testable against the export. Matches "read-only view" literally. **Recommended starting point.**
   - *Heavy:* reconstruct a call graph from the SCIP index and write it into the SQLite/llm-context store so MCP tools/`orient` can query imported symbols — much larger, and risks touching MCP/`orient`, which the scope contract forbids.
   - Decision needed before implementing: which interpretation, and which PR.

---

## Context for you (the agent)

**SCIP** (Source Code Intelligence Protocol) is Sourcegraph's open-source successor to LSIF. It is a protobuf-defined format for representing symbolic code indexes (occurrences, symbols, documents, ranges). Adopting SCIP as an *export* format is a small change that makes OpenLore consumable by the wider symbolic-code-graph ecosystem: Sourcegraph code nav, GitHub's stack-graph viewer, Glean importers, and any downstream agent tool that already knows how to parse SCIP.

This is a one-way interop move. We are not replacing OpenLore's internal graph schema (which has McCabe complexity, community-detection clusters, drift state, and other fields SCIP does not model). We are adding `openlore export scip` that emits a `index.scip` file derived from the graph we already have. Optionally, also `openlore import scip` as a stub that ingests an existing `index.scip` into a read-only OpenLore view — but only if that fits cleanly; ship export-only if import would balloon scope.

## Scope contract — do not break these things

This PR must NOT:

- Change OpenLore's internal graph schema, MCP tools, or `orient()`.
- Make SCIP a *required* path; the existing SQLite graph remains canonical.
- Add a hard dependency on Sourcegraph tooling. Use only the SCIP protobuf schema (published, MIT-licensed, generated client code is small).
- Convert lossily and silently. If a field in the OpenLore graph has no SCIP equivalent, that is fine — but if information that an SCIP consumer would expect (a symbol's defining range, e.g.) is *missing* from our graph, fail the export with a clear diagnostic; do not write a malformed index.

This PR must:

- Use the upstream SCIP `.proto` schema (vendored or fetched at build time — vendored is fine, file is small). Reference: https://github.com/sourcegraph/scip/blob/main/scip.proto. Pin the version in a comment.
- Produce a valid `index.scip` that Sourcegraph's `scip` CLI accepts (we cannot require Sourcegraph CLI as a dev dep, but the format is the spec — write tests that round-trip parse the output against the protobuf schema).
- Be stable: re-running the export on an unchanged graph produces byte-identical output (deterministic ordering of documents, occurrences, symbols).

## The deliverable

Add a new CLI subcommand: `openlore export scip`.

```
openlore export scip [--out <path>] [--project-root <path>] [--include <glob>...] [--exclude <glob>...]
```

Behavior:

- Loads the existing OpenLore graph.
- For every function node, emit an SCIP `Symbol` with a stable symbol moniker derived from `<repo-rel-path>#<qualified-name>(<arity>)`.
- For every call edge, emit an SCIP `Occurrence` with `symbol_roles = ReadAccess` at the call site and the corresponding `Definition` occurrence at the callee.
- For every file, emit one `Document` with its language, path, and occurrences sorted by `(line, col)`.
- Index-level metadata: `project_root`, `tool_info { name = "openlore", version = <pkg.version> }`, `text_document_encoding = UTF8`.
- Default output path: `index.scip` at repo root.
- `--include`/`--exclude` filter which files participate.

### Choices to document, not invent

- **Symbol moniker format.** Use SCIP's recommended scheme: `scheme=openlore manager=npm name=<pkg> version=<v> descriptor=<file>/<symbol>(<arity>).`. If the OpenLore graph does not carry enough info to fill any of these slots, use the literal string `local` per the SCIP spec.
- **Languages.** Map OpenLore's language tags to SCIP's `Language` enum. For languages we analyze that SCIP has no enum value for, use `UnspecifiedLanguage` and note in the export summary.
- **Ranges.** OpenLore's call sites should carry `(start_line, start_col, end_line, end_col)`. If only line is available, emit a zero-width range at column 0 and log a warning.

### Implementation notes

- Use the `protobufjs` package (pure JS, no native build) for serialization. Add as a runtime dependency *only* if no lighter option works. If a single-file generated `pb.js` from the SCIP `.proto` fits in <100KB, vendor that and skip the dep — preferred.
- Put SCIP logic in `src/core/scip/` so it is cleanly isolated. Public surface: a single `exportScip(graph, options): Buffer` function plus the CLI wrapper.
- Add a test fixture: a tiny 3-file repo, run analyze + export, parse the result back through the protobuf schema, and assert known invariants (file count, occurrence count, at least one `Definition`).

### Documentation

- `docs/scip-export.md` (~one page): what SCIP is, what we export, what we *don't* export, how to consume (`scip convert --to lsif`, upload to Sourcegraph, etc.).
- One section in the main README under "Interop": "OpenLore exports SCIP. Plug it into Sourcegraph, GitHub stack graphs, or any SCIP-aware tool."

### Out of scope for this PR

- SCIP *import* (consume someone else's SCIP into OpenLore's graph). Leave `TODO(spec-04-followup): scip import` and ship export-only.
- Language coverage gaps in the analyzer. If a language is missing from OpenLore's analyzer, that does not become this PR's problem.
- LSIF export. SCIP is the modern path; downstream consumers can convert.

## Files you will create or modify (approximate)

```
src/core/scip/
  index.ts                 # exportScip()
  schema.ts                # protobuf schema loading
  moniker.ts               # symbol moniker derivation
  vendor/scip.proto        # pinned SCIP proto, with version comment
  vendor/scip-pb.js        # OR a generated pure-JS pb module if vendored
src/cli/export/
  index.ts                 # `openlore export <format>` dispatch
  scip.ts                  # CLI wrapper
src/cli/index.ts           # register `export` subcommand
docs/scip-export.md
test/core/scip/
  export.test.ts
  fixtures/tiny-repo/      # 3-file fixture
README.md                  # add Interop section
```

## Acceptance criteria

1. `openlore export scip` produces `index.scip` against the fixture; the file is non-empty and parses back through the SCIP protobuf schema in a unit test.
2. Output is byte-deterministic across runs on the same graph (test by running twice and comparing SHA-256).
3. Documents are sorted by relative path. Occurrences within a document are sorted by `(line, col)`. Symbols within a document are deduplicated.
4. The fixture's expected occurrence count is asserted exactly (lock the number in once you compute it; small fixture).
5. `openlore export scip --include 'src/**' --exclude 'src/**/*.test.*'` filters as documented.
6. README "Interop" section is present; `docs/scip-export.md` exists.
7. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass.
8. If a new runtime dep (`protobufjs`) is added, the PR description justifies it explicitly and confirms the package's size and zero-native-build property.

## Git workflow — read carefully

1. Branch: `openlore-spec-04-scip-export` off the default branch.
2. **Open exactly one PR** titled `spec-04: SCIP export for ecosystem interop`. Body: link to upstream SCIP spec, the pinned proto version, and a `wc -l` of the generated output against the fixture.
3. All follow-up commits for this spec push to the same PR. Never open a second PR. If the design needs to change mid-flight, push more commits.
4. If the analyzer is missing data needed to produce a faithful SCIP file (e.g., column-level ranges), STOP and fail loudly in the export with a clear error message telling the user which fields are missing. Do not invent data. Leave `TODO(spec-04-followup): column ranges in analyzer` and ship.
5. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

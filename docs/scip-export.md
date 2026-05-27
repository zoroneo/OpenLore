# SCIP Export

`openlore export scip` emits an `index.scip` file derived from the analysis
graph, making OpenLore consumable by the wider symbolic-code-graph ecosystem.

## What is SCIP?

[SCIP](https://github.com/sourcegraph/scip) (Source Code Intelligence Protocol)
is Sourcegraph's open, protobuf-defined successor to LSIF. It models a symbolic
code index as **documents** (files), **symbols** (monikers), and **occurrences**
(symbol references with ranges and roles). Tools that already understand SCIP
include Sourcegraph code navigation, GitHub's stack-graph viewer, and Glean
importers.

OpenLore vendors the upstream schema verbatim at
[`src/core/scip/vendor/scip.proto`](../src/core/scip/vendor/scip.proto)
(pinned — see the header comment in that file). We serialize with
[`protobufjs`](https://www.npmjs.com/package/protobufjs), a pure-JS library with
no native build step.

## Usage

```bash
openlore analyze                       # build the graph first
openlore export scip                   # writes ./index.scip

openlore export scip --out build/index.scip
openlore export scip --project-root /path/to/repo
openlore export scip --include 'src/**' --exclude 'src/**/*.test.*'
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--out <path>` | `<project-root>/index.scip` | Output path |
| `--project-root <path>` | current directory | Repo to export |
| `--include <glob>` | (all) | Only include matching files (repeatable) |
| `--exclude <glob>` | (none) | Drop matching files (repeatable) |

Globs are matched against repo-relative POSIX paths and support `*`, `?`, `**`,
and `**/`.

## What we export

- **One `Document` per source file**, with its SCIP `Language` tag and
  occurrences sorted by `(line, column)`.
- **One `Symbol` per function/method**, with a stable moniker:

  ```
  openlore npm <package> <version> `<repo-rel-path>`/<qualified-name>(<arity>).
  ```

  Example: ``openlore npm openlore 2.0.2 `src/core/scip/index.ts`/exportScip(1).``
  The package coordinates come from the target repo's `package.json` (or a
  manifest-inferred manager and the directory name when none exists).

- **A `Definition` occurrence** at each function's defining line, and a
  **`ReadAccess` occurrence** at each call site whose callee is also exported.

Index-level metadata records `project_root` (as a `file://` URI),
`tool_info { name = "openlore", version }`, and `text_document_encoding = UTF8`.

The output is **byte-deterministic**: re-running on an unchanged graph produces
an identical file (documents sorted by path, occurrences by `(line, col)`,
symbols deduplicated and sorted).

## What we don't export

This is a one-way, lossy projection. OpenLore's graph carries information SCIP
has no place for, and it is simply dropped: McCabe complexity, community-detection
clusters, drift state, layer violations, hub/entry-point classification, and
inheritance edges.

Known fidelity gaps:

- **Column-level ranges.** The analyzer records line numbers but not columns
  today, so occurrences are emitted as zero-width ranges at column 0. The
  exporter warns once per run.
  `TODO(spec-04-followup): column ranges in analyzer.`
- **Arity.** Parameter counts are parsed best-effort from the declaration
  signature; when no signature is available the method disambiguator is empty.
- **Languages without a SCIP enum value** are tagged `UnspecifiedLanguage` and
  listed in the export summary.

If a function node is missing even a defining *line* — a range a SCIP consumer
fundamentally expects — the export **fails loudly** rather than writing a
malformed index. Re-run `openlore analyze` to rebuild the graph.

`scip import` (consuming an external SCIP index into OpenLore's graph) is not
implemented. `TODO(spec-04-followup): scip import.`

## Consuming the output

```bash
# Validate / inspect with Sourcegraph's scip CLI (optional, not a dev dep):
scip print index.scip

# Convert to LSIF for tools that still speak LSIF:
scip convert --from index.scip --to dump.lsif

# Upload to a Sourcegraph instance:
src code-intel upload -file=index.scip
```

OpenLore itself does not require the Sourcegraph CLI; the protobuf schema is the
contract.

# Local Provenance (Git & PR Metadata)

> Spec 18. **Local-only. No OAuth. No cloud connector. Nothing is ever uploaded.**

The most valuable provenance — *who last changed this code, in which PR* — already lives
in your local `.git` history and is reachable through the local `gh` CLI under your own
existing authentication. OpenLore reads it locally and projects it onto the graph, so
`orient` can answer "last changed by X in PR #N" — a provenance question grep cannot.

This is the deliberate alternative to cloud OAuth connectors: it keeps OpenLore inside its
prime constraint — **local, deterministic, nothing leaves your machine.**

## The guarantee

| | |
|---|---|
| **Network** | None on the git-only path. `gh` (if used) talks to GitHub under *your* existing auth; OpenLore sends nothing itself. |
| **Upload** | Never. Provenance is read, projected into the local SQLite graph, and surfaced locally. |
| **`gh` required?** | No. Absent/unauthenticated/non-GitHub → graceful git-only degradation (`authored_by` works; PR titles are simply omitted). |
| **Shallow / no history** | Yields no provenance and never blocks `analyze`. |
| **Determinism** | Fully deterministic for a fixed git state on the git-only path. |

## What it extracts

Two edge kinds, projected onto existing file nodes (derived and regenerable on every
`analyze`, behind the `SCHEMA_VERSION` bump — no migration):

- **`authored_by`** (file → person): the last-touch author plus the top-N recent distinct
  authors, from non-merge commits (the real contributors, not whoever clicked "merge").
- **`changed_in_pr`** (file → PR): PR numbers parsed from commit subjects — squash merges
  `(#123)` and merge commits `Merge pull request #123`. With `gh` present, PRs are enriched
  with title and state; without it, the numbers alone.

### Bounds (no graph bloat)

Provenance is capped and the caps are explicit:

| Cap | Default | Constant |
|-----|---------|----------|
| History depth scanned | 1000 commits/pass | `PROVENANCE_MAX_COMMITS` |
| Recent authors per file | 5 | `PROVENANCE_TOP_AUTHORS` |
| PRs per file | 5 | `PROVENANCE_MAX_PRS` |

## In `orient`

When a task touches files with recorded provenance, `orient` adds an additive `provenance`
block (omitted entirely when there's none):

```jsonc
{
  "provenance": [
    { "file": "src/core/services/edge-store.ts",
      "lastAuthor": "Clay Good",
      "lastDate": "2026-06-02T08:11:45-05:00",
      "lastPr": 112,
      "lastPrTitle": "cross-domain code↔infra impact analysis" }
  ]
}
```

## How it works

Mirrors the IaC and decisions parser→projector split:

- **Parser** — [`git-provenance.ts`](../src/core/provenance/git-provenance.ts): two bounded
  `git log` passes (authors from `--no-merges`; PR attribution from `--merges --first-parent`)
  via `execFile('git', …)` — the same local wrapper drift detection already uses. Optional
  one-shot `gh pr list` enrichment, best-effort.
- **Projector** — [`project.ts`](../src/core/provenance/project.ts): per-file records →
  typed `authored_by` / `changed_in_pr` edges.
- **Storage** — a single per-file `provenance` table in the edge store; surfaced in `orient`
  via a tolerant path join.

The same git history feeds the change-coupling & volatility instrument (Spec 22): provenance
edges here, statistical co-change analysis there.

Tested over a real temporary git repo with controlled authors/PRs plus graceful-degradation
paths in [`git-provenance.test.ts`](../src/core/provenance/git-provenance.test.ts).

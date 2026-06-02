# OpenLore Spec 18 — Local Provenance Edges (Git & PR Metadata, No OAuth)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md).

---

## Progress

Branch: `openlore-spec-18-local-provenance-edges`. **DONE** (PR pending).

- [x] `authored_by` and `changed_in_pr` edges sourced from local git / `gh` — new
      `EdgeKind`s; extractor [git-provenance.ts](../../src/core/provenance/git-provenance.ts)
      runs two bounded `git log` passes (real authors from `--no-merges`; PR attribution from
      squash `(#N)` subjects + `--merges --first-parent`). Validated on this repo's real merge
      history (e.g. `edge-store.ts` → PRs #112, #111, …).
- [x] Projected onto existing file nodes (derived, regenerable) —
      [project.ts](../../src/core/provenance/project.ts) maps records to typed `authored_by`/
      `changed_in_pr` edges; stored one row per file in a new `provenance` table (no person/PR
      nodes → no graph bloat). Wired into `writeEdgesToSQLite` (best-effort, local-only).
      `SCHEMA_VERSION` 3 → 4 (rebuild-on-bump).
- [x] Surfaced additively in `orient` — optional `provenance` block ("last changed by X in
      PR #N"), omitted when there is none.
- [x] Graceful degradation — git-only when `gh` is absent/unauthenticated/non-GitHub
      (`authored_by` works, PR titles omitted); `[]` for non-git/shallow, never blocks `analyze`.
- [x] Deterministic for a fixed git state; **no network upload on any path**. Caps documented
      (`PROVENANCE_MAX_COMMITS`/`TOP_AUTHORS`/`MAX_PRS`). Doc:
      [docs/provenance.md](../provenance.md). Tests over a real temp git repo (authors, squash
      + merge PRs, determinism, no-git, gh-absent) + projector + edge-store + orient. Full suite
      green (2993 passing / 134 files).

---

## Context for you (the agent)

This is the "code ↔ organizational context" join made real **without any cloud surface**. Today
git is used only for changed-file diffing in drift detection; pull requests are never parsed and
no provenance edges exist. Yet the most valuable provenance — "who last changed this function,
in which PR, citing which decision" — is sitting in the local `.git` history and reachable via
the local `gh` CLI under the user's existing authentication.

Parsing that locally yields `authored_by` (code → person) and `changed_in_pr` (code → PR) edges
that let `orient` answer provenance questions grep cannot. Crucially, this stays inside Spec 13's
prime constraint: **local, deterministic, nothing uploaded.** It is the deliberate alternative to
cloud OAuth connectors, which Spec 13 fences to an optional far-horizon plugin precisely because
they would forfeit this local-only guarantee.

The git history this ingests is also the data source for the **change-coupling & volatility
instrument (Spec 22)**: provenance edges here, statistical co-change analysis there.

## Scope contract — do not break these things

This PR must NOT:

- Introduce OAuth, cloud connectors, or any network upload. Reads are local git plus local `gh`
  using the user's own credentials; nothing is sent anywhere.
- Require `gh`. When `gh` is absent or unauthenticated, degrade gracefully to git-only provenance.
- Fail or block `analyze` when git history is shallow or absent.
- Bloat the graph. Cap provenance (for example, last-touch author plus top-N recent authors per
  node) and document the cap; do not import unbounded history.

This PR must:

- Add a local provenance extractor (parser→projector pattern) producing `authored_by` and
  `changed_in_pr` edges, optionally `references` edges for issue/SHA mentions in commit messages.
- Project these onto existing function/file nodes as derived, regenerable graph data.
- Surface provenance additively in `orient` ("last changed by X in PR #N").
- Be deterministic for a fixed git state and fully offline (git-only path requires no network).
- Document the no-OAuth / no-upload guarantee prominently.

## The deliverable

- A git/`gh` provenance extractor + projector, mirroring the existing parser→projector split.
- `EdgeKind` extensions for the new provenance edges.
- `orient` surfacing of last-author / PR provenance, additive to its current response.
- Tests over a fixture repository with commit history, covering both the `gh`-present and
  git-only paths.

## Implementation approach (where it lives)

- **Extend the existing local git wrapper.** Add `getGitLog()` / `getCommitBlame()` beside the
  current helpers in [git-diff.ts](../../src/core/drift/git-diff.ts) (already `execFile('git', …)`,
  no `gh`, no network) for `authored_by` and last-touch. PR metadata comes from local `gh` **only
  if it is present and authenticated**, with a graceful git-only fallback.
- **Projector** (parser→projector pattern, like IaC) maps to `authored_by` (code → person) and
  `changed_in_pr` (code → PR) edges on existing function/file nodes; derived and regenerable.
- **New `EdgeKind`s** `authored_by` / `changed_in_pr` (additive). `orient` surfaces last-author /
  PR additively.

## Compatibility verification (grounded 2026-05-30)

- **Local-only:** `execFile` git + optional local `gh`; no network upload. `gh` is optional and
  never on the core path.
- **New `EdgeKind`s are additive** (defensive `calls`-only filters ignore them). If persisted,
  behind a `SCHEMA_VERSION` bump.
- `orient` gains **optional** fields only.

## Edge cases & failure modes

- **Shallow / no history** → degrade to no provenance and say so; never block `analyze`.
- **`gh` absent / unauthenticated** → git-only path (`authored_by` works; `changed_in_pr` may be
  empty).
- **Bound graph growth:** cap provenance (last-touch + top-N recent authors per node) and document
  the cap.

## Acceptance

- `orient` / impact surfaces last-author and originating PR for a function as graph edges.
- The git-only path works with no network and no `gh`.
- No network upload occurs on any path; the guarantee is documented and tested.

## Compatibility note

Additive and local-only. `gh` is optional with graceful degradation. The graph projection is
derived and rebuilt on the `SCHEMA_VERSION` bump; no user data leaves the machine.

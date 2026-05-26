# OpenLore Spec 03 — `openlore preflight` CI Staleness Check

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Context for you (the agent)

OpenLore persists an architectural graph (call graph + clusters + complexity + specs + decisions) to a SQLite store. The graph is built by `openlore analyze` and consumed by `openlore orient` / the MCP server. If the graph is **stale** relative to the source — i.e., source files have changed since the graph was last built — then `orient()` returns out-of-date information and the deterministic guarantees of OpenLore quietly degrade.

Today, freshness is the user's responsibility. They are expected to re-run `openlore analyze` after meaningful changes. In practice, many teams forget. The Epistemic Lease subsystem catches this at *agent runtime* via a freshness signal, but it does not catch it at *PR time*, which is the cheap place to enforce.

**This PR adds a `preflight` mode** that any CI system can run as a non-zero-exit check on every PR: it determines whether the graph is current relative to the working tree, and optionally rebuilds the delta and commits the result. This is the staleness gate at the boundary where it is cheapest.

## Scope contract — do not break these things

This PR must NOT:

- Change the graph schema, the analyzer, or `orient()` output.
- Add new runtime dependencies (the analyzer is already in-process; we just need to call it differently).
- Require an API key for the staleness check itself (spec layer with LLM generation is out of scope for preflight; only structural staleness matters here).
- Add telemetry, network calls, or anything that phones home.
- Couple to a specific CI system. The command must work on GitHub Actions, GitLab CI, CircleCI, Buildkite, local dev, anywhere.

This PR must:

- Be exit-code-clean (0 = fresh, 1 = stale, 2 = error).
- Be fast (< 5s on a warm SQLite for a repo of ~10k functions; we are only diffing, not re-analyzing in the default path).
- Print a human-readable summary by default and a `--json` mode for machine consumption.

## The deliverable

Add a new CLI subcommand: `openlore preflight`.

```
openlore preflight [--fix] [--json] [--since <git-ref>] [--max-staleness <int>]
```

Behavior:

- Loads the existing graph (refuse with exit 2 and a clear message if none exists; suggest `openlore analyze`).
- Determines the set of source files that have changed since the graph was built. The "graph build commit" is stored as graph metadata; if missing, fall back to the graph's `built_at` timestamp vs. file mtimes.
- With `--since <git-ref>` (e.g. `--since origin/main`), use git diff against that ref instead of graph metadata. This is the CI-friendly mode: "have files relevant to this PR changed in ways that would invalidate orient() answers?"
- Computes a *staleness score*: number of changed files × weight, weighted by how connected they are in the graph (a change to a hub function invalidates more than a change to a leaf). Pick a simple weighting; document it.
- With `--max-staleness <n>` (default `0` for hard, `5` permissive), exits 1 if score > n.
- Prints, by default:
  ```
  OpenLore preflight
  ──────────────────
  Graph built:   <iso8601>   commit <short-hash>
  Working tree:  <iso8601>   commit <short-hash>
  Changed files: 7 (3 hub, 4 leaf)
  Staleness:     score 11 (threshold 0)
  Status:        STALE — run `openlore analyze --incremental` or re-run with --fix
  ```
- With `--fix`, runs `openlore analyze --incremental` (if it exists) or `openlore analyze` (full re-run) and re-checks. Exits 0 if the fix succeeds.
- With `--json`, prints a JSON object with `{ status, graph_built_at, graph_commit, working_commit, changed_files: [...], staleness_score, threshold }` and skips the human-readable output.

### CI template

Ship a copy-pasteable GitHub Actions workflow at `examples/ci/openlore-preflight.yml`:

```yaml
name: OpenLore preflight
on:
  pull_request:
permissions:
  contents: read
jobs:
  preflight:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npx --yes openlore preflight --since origin/${{ github.base_ref }}
```

Also ship a GitLab CI snippet and a generic shell snippet in the same `examples/ci/` directory. Keep them short.

### Edge cases to handle

- No `.git` directory: fall back to mtime-based comparison; print a note in the human output.
- Graph built against a commit that is no longer in the repo (force-push, rebase): fall back to file mtimes; print a warning.
- `--since` ref does not exist: exit 2 with a clear message.
- Repo with no source files matching the graph's language config: exit 0 with "nothing to check."

### Documentation

Add `docs/preflight.md` (~one page) covering: what it checks, what it does NOT check (spec drift is the existing drift detector's job — link to it), how to wire it into CI, how to interpret the staleness score.

## Files you will create or modify (approximate)

```
src/cli/preflight/
  index.ts           # subcommand entry
  diff.ts            # changed-files computation (git + mtime fallback)
  score.ts           # staleness scoring
  report.ts          # human + JSON renderers
src/cli/index.ts     # register subcommand
examples/ci/
  openlore-preflight.yml
  openlore-preflight.gitlab.yml
  openlore-preflight.sh
docs/preflight.md
test/cli/preflight/*.test.ts
test/cli/preflight/fixtures/  # tiny repo fixtures
```

## Acceptance criteria

1. In a freshly-analyzed clean repo, `openlore preflight` exits 0 with status `FRESH`.
2. After editing one source file (no re-analyze), `openlore preflight` exits 1 with status `STALE` and lists the file.
3. After running `openlore preflight --fix`, the graph is updated and a follow-up `openlore preflight` exits 0.
4. `openlore preflight --json` produces parseable JSON with the documented schema; the shape is tested.
5. `--since origin/main` works in a repo where `origin/main` is the merge base.
6. The GitHub Actions example is syntactically valid YAML (test by parsing it in a unit test).
7. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass.
8. No new runtime dependencies.

## Git workflow — read carefully

1. Branch: `openlore-spec-03-preflight-ci` off the default branch.
2. Implement only `preflight`. Do NOT extend `analyze` itself in this PR even if you discover the incremental path is missing. If `--fix` cannot incrementally analyze, run the full analyzer; leave a `TODO(spec-03-followup): incremental analyzer`.
3. **Open exactly one PR** titled `spec-03: openlore preflight — CI staleness gate`. Body must include the human-readable output sample.
4. All follow-up commits for this spec push to that same PR. Never open a second PR for spec-03. If you have to re-think the design, push more commits.
5. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

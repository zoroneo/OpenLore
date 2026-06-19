@.openlore/analysis/CODEBASE.md
@openspec/specs/overview/spec.md

# openlore MCP tools — when to use them

| Situation | Tool |
|-----------|------|
| Starting any new task | `orient` — returns functions, files, specs, call paths, and insertion points in one call |
| Don't know which file/function handles a concept | `search_code` |
| Need call topology across many files | `get_subgraph` / `analyze_impact` |
| "Which tests must I run for this change?" | `select_tests` — backward reachability to the reaching tests |
| "What's the blast radius of my diff before I commit?" | `blast_radius` — one advisory briefing: callers/layers, tests to run, anchored memories/decisions that will drift, stale specs |
| "What's unreachable / what dies if I delete X?" | `find_dead_code` — cross-language reachability (candidates) |
| Reviewing a change: structural delta + stale callers | `structural_diff` |
| "What changes together with this / what's volatile?" | `get_change_coupling` — co-change + churn from git |
| Lay of the land / where do regions connect? | `get_map` (region view; pass a communityId to drill in) |
| Find the route from A to B (by name, role, or landmark) | `find_path` (cheapest call path + alternates) |
| Planning where to add a feature | `suggest_insertion_points` |
| Reading a spec before writing code | `get_spec` |
| Checking if code still matches spec | `check_spec_drift` |
| Finding spec requirements by meaning | `search_specs` |
| Checking spec coverage before starting a feature | `audit_spec_coverage` |
| Recording an architectural decision before writing code | `record_decision` |
| Persisting a durable, code-anchored fact for later sessions | `remember` (opt-in `memory` preset) — anchors a note to a symbol/file so it self-invalidates; optional `type` (invariant/gotcha/rationale/…, default note) and `supersedes=<id>` to retire a prior memory (kept queryable via `asOf`); re-recording the same content+anchor updates in place |
| Recalling what's known about code you're touching | `recall` (opt-in `memory` preset) — returns memories with a freshness verdict (never serves orphaned ones as authoritative); two authoritative memories on one symbol surface in `unreconciled`; optional `asOf`/`changedSince` (commit-ish) for history and a `type` filter |
| Persisting a durable, code-anchored fact for later sessions | `remember` (opt-in `memory` preset) — anchors a note to a symbol/file so it self-invalidates |
| Recalling what's known about code you're touching | `recall` (opt-in `memory` preset) — returns memories with a freshness verdict; never serves orphaned ones as authoritative |
| About to assert a structural fact to a user ("X is dead", "Y calls Z", "this is safe to change") | `verify_claim` (opt-in `verify` preset) — verify the claim against the graph, then cite the receipt to the human; an `unverifiable` verdict means hedge or read the source |

For all other cases (reading a file, grepping, listing files) use native tools directly.

> **Memory tools (`remember`/`recall`) are opt-in:** they ship in the `memory` preset
> (`openlore mcp --preset memory`), not the default or `minimal` surface, per the
> `mcp-quality` minimize-tool-surface rule.

> **Authoring a new MCP tool?** Classify it `conclusion` or `explicit-topology` in
> `src/core/services/mcp-handlers/tool-contract.ts` — `tool-contract.test.ts` fails until you do.
> Conclusion tools must return the computed answer, not a graph for the agent to traverse.

<!-- openlore-decisions-instructions -->
## Architectural decisions

When making a significant design choice, call `record_decision` **before** writing the code.

Significant choices: data structure, library/dependency, API contract, auth strategy,
module boundary, database schema, caching approach, error handling pattern.

```
record_decision({
  title: "Use JWTs for stateless auth",
  rationale: "Avoids session store in infra",
  consequences: "Tokens can't be revoked early",
  affectedFiles: ["src/auth/middleware.ts"],
  supersedes: "a1b2c3d4"  // 8-char ID of prior decision being reversed
})
```

Decisions are consolidated in the background immediately after `record_decision` is called — the pre-commit gate reads the already-consolidated store and adds no LLM latency.

**Performance note**: if you skip `record_decision`, the gate detects unrecorded source changes at commit time and triggers a slow LLM extraction on the *next* commit (~10-30s). Calling `record_decision` proactively keeps every commit instant.

## When git commit is blocked by the decisions gate

If `git commit` fails and the output is JSON with `"gated": true`, do NOT retry silently.
Check the `reason` field and act accordingly:

**`reason: "verified"` — decisions await review:**
Present each decision to the user:
> "The commit is blocked — I found N architectural decision(s) to validate:
> 1. **[id]** Title — rationale
Do you approve? (yes/no)"
For each approval call `approve_decision`, for rejections call `reject_decision`.
Then run `openlore decisions --sync` and retry `git commit`.

**`reason: "approved_not_synced"` — decisions approved but not written to specs:**
Run `openlore decisions --sync` then retry `git commit`. Do not skip this step.

**`reason: "drafts_pending_consolidation"` — drafts were recorded but not yet consolidated:**
Present to the user:
> "N decision draft(s) were recorded but never consolidated. Run consolidation now? (~10-30s)"
If yes: run `openlore decisions --consolidate --gate` and handle the result.
If no: retry with `git commit --no-verify` to skip the gate.

**`reason: "no_decisions_recorded"` — source files staged but nothing recorded:**
Present to the user:
> "Source files are staged but no architectural decisions were recorded. Run fallback extraction to check for undocumented decisions? (~10-30s)"
If yes: run `openlore decisions --consolidate --gate` and handle the result.
If no: retry with `git commit --no-verify` to skip the gate.
<!-- end-openlore-decisions-instructions -->

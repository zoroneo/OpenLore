# Fix transitive (depth-N) staleness in incremental updates

> Status: IMPLEMENTED (2026-06-23). Substrate correctness fix in the incremental watch path
> (`src/core/services/mcp-watcher.ts`, `src/core/services/edge-store.ts`, `src/core/analyzer/call-graph.ts`).
> No new MCP tool, no LLM. This fixes the graph, and uses an *explicit* staleness flag only as a bounded
> fallback — not as the primary mechanism.
>
> **As built.** The reverse-dependency closure is computed per changed file as: direct callers
> (`getCallerFiles`, no longer truncated at 10) ∪ prior non-callers whose previously-`external` call
> sites a symbol the edit ADDED should now bind (`getExternalConsumerFiles`, new). Because the set of
> added/removed symbols is fully determined by the changed files in a batch, re-resolving this expanded
> set is provably sufficient — the fixpoint converges in one expansion, so no iteration loop is needed.
> A latent bug this exposed is also fixed: the incremental resolution seed
> (`CallGraphBuilder.build(resolutionNodes)`) no longer re-injects stale nodes for files in the
> re-parsed subset, which previously re-bound a renamed-away caller to the old symbol id. The budget is
> `INCREMENTAL_CLOSURE_BUDGET` (default 40); over-budget files are marked stale in a new additive
> `stale_files` table. Freshness honors the region by downgrading an unchanged-but-in-stale-region
> symbol from `fresh` to `drifted` (with an `AnchorVerdict.staleRegion` marker) — no new enum value.
> Self-heal is opportunistic (a stale file's mark clears when it is next recomputed); `analyze --force`
> (`clearAll`) clears the whole region. Verified by `src/core/services/mcp-watcher-parity.test.ts`
> against a from-scratch build oracle, and dogfooded end-to-end on the real compiled CLI + SQLite.
>
> **Review hardening (adversarial pass).** Four issues found by adversarial e2e review were fixed: (1)
> the class-P consumer discovery ran only when the budget had room, so a hub edit that filled the budget
> with direct callers left an added symbol's external consumers *silently* divergent — discovery now
> runs unconditionally and overflow consumers are marked stale. (2) `name_only` resolution picked a
> duplicate-name winner by insertion order, which differs between a from-scratch and an incremental
> build — `FunctionRegistryTrie.findBySimpleName` now sorts candidates by symbol id (deterministic), and
> the closure also re-resolves `name_only` consumers of an added name (`getNameOnlyConsumerFiles`), not
> just `external` ones. (3) `handleDeletions` now clears stale marks for deleted files (no phantom
> rows). (4) freshness honors the stale region for file-level anchors too (`fileInStaleRegion`), not
> only symbol anchors. All four have regression tests and were dogfooded on the real CLI.
>
> **Review hardening (second adversarial pass).** Two more fixes: (5) `name_only` consumer
> re-resolution was pruned to only the consumers an added symbol can actually flip — a consumer keeps a
> `name_only` edge to the lowest-id candidate, so the new symbol matters only when its id sorts before
> the consumer's current target (`getNameOnlyConsumers` now returns the callee id for the comparison).
> Without this, a common-name add (`get`/`run`) needlessly re-parsed and stale-flagged dozens of
> unaffected consumers (measured ~20 needless stale + a ~30x latency spike on a 60-consumer corpus); the
> prune drops both to zero. (6) a file that the closure intends to recompute but cannot READ
> (permissions / transient I/O / a lock) is no longer emptied-and-asserted-fresh — `buildGraphSubset`
> reports `skipped` files, whose edges are preserved and which are marked stale (the one silent-
> divergence the contract forbids). Both have regression tests and were dogfooded on the real CLI.
>
> **Accepted, documented behavior (sound over-approximation).** A budget-exceeded edit marks the
> un-recomputed files stale, which (a) flips file-level *decision* anchors on those files to `drifted`
> (with the `staleRegion` marker) even though their content is byte-identical, and (b) excludes any
> downgraded memory from `findUnreconciled` contradiction detection until the region self-heals. Both
> are sound (the topology genuinely was not recomputed) and, after fix (5), only occur on a genuine
> large-fan-in hub edit — honest "verify this, it wasn't recomputed" signals, not silent loss.

## Why

OpenLore's load-bearing promise is: **you are told when a fact is stale.** The incremental watch
path quietly breaks that promise.

Today the watcher (`--watch-auto`, on by default) is **depth-1 only** — documented plainly in
`README.md:593`:

> Incremental call graph updates are depth-1 only … the changed file and its direct callers are
> re-parsed … Transitive callers (`A→B→C`, `C` changes, `A` stays stale) are only refreshed by the
> next `analyze --force`.

Concretely, in `mcp-watcher.handleBatch` (`mcp-watcher.ts:407`) → `buildGraphSubset`
(`mcp-watcher.ts:989`): when `C` changes, the watcher re-parses `C` and up to `CALLER_REPARSE_LIMIT
= 10` *direct* callers (`getCallerFiles`, `edge-store.ts:235`), deleting and re-inserting only their
edges (`deleteOutgoingEdgesForFile`, `edge-store.ts:324`). Anything two or more hops upstream — and
any newly-introduced symbol that a non-caller file should now resolve to — is never revisited. The
graph diverges from what `analyze --force` would produce, and stays diverged until the next full run.

Two problems compound:

1. **The graph is wrong, not just unfreshened.** Derived/transitive answers (reachability, blast
   radius up the call chain, "who is affected by `C`") read a graph that no longer matches the source.
2. **The wrongness is silent.** The Epistemic Lease / anchor-freshness machinery
   (`src/core/decisions/anchor.ts:121`) verdicts only the *directly anchored* symbol — it checks that
   the anchored node still exists and its content hash matches, with **no transitive re-check**
   (`anchor-adapter.ts:83`). So a memory anchored to `A` can read `fresh` while the topology under `A`
   is stale. Time-decay papers over the symptom; it does not detect this class of error.

This is a trust-eroding correctness gap in the one feature OpenLore most needs to be right about. The
fix belongs in the substrate.

## What changes

1. **Converge the incremental update to the full-analyze result.** Replace the fixed "changed file +
   ≤10 direct callers" rule with **change-driven, bounded transitive invalidation**: from the set of
   edges/symbols that actually changed in this batch, walk the reverse-dependency closure
   (`getCallerFiles` iterated to fixpoint), re-parsing and re-resolving only the files whose edges
   could change as a consequence, until no further edge resolution changes. The strong success
   criterion: **for the affected region, the post-incremental graph equals the `analyze --force`
   graph** — verified by a property/parity test, not by inspection.

2. **A bounded work budget with an honest fallback.** Full transitive closure is `O(depth × fanIn)`
   and a hub change could touch the whole repo. Cap the per-batch closure work at a configurable
   `INCREMENTAL_CLOSURE_BUDGET`. When a batch exceeds the budget, the watcher SHALL **mark the
   un-recomputed region explicitly `stale`** in the graph metadata so that freshness verdicts and any
   conclusion drawn over that region report `stale` (honest) instead of serving silently-wrong
   topology. The fallback preserves the "told when stale" promise *as a fallback*, not as the design.

3. **Freshness verdicts honor the stale region.** Anchor freshness (`anchorFreshness`) and any
   conclusion-shaped tool that reads the graph SHALL treat a symbol inside an explicitly-marked stale
   region as `stale`/unreliable rather than authoritative — closing the gap where a memory anchored to
   `A` reads `fresh` while `A`'s subgraph is stale.

4. **A self-healing tail.** A marked-stale region SHALL be reconciled — either opportunistically as
   subsequent edits touch it, or by a background pass — so the stale region shrinks toward empty
   without requiring a manual `analyze --force`. The full `analyze --force` clears it entirely and
   remains the ground truth the parity test is written against.

## What does NOT change

- **No LLM, no new structural computation kind.** This re-runs the *existing* tree-sitter edge
  resolution over a correctly-chosen set of files; it does not add a new analysis (north star
  `c6d1ad07`).
- **No new MCP tool.** This hardens an existing path; the tool surface is unchanged.
- **`analyze --force` stays the ground truth.** The incremental path is defined as "converge to what
  `analyze --force` produces, or flag the difference," never as a divergent approximation.
- **The watcher stays light.** Build/dependency directories are still pruned; the budget keeps a hub
  change from stalling the watcher — it degrades to an explicit stale flag instead.

## Research basis

This is standard incremental/demand-driven program analysis: an incremental update must be *sound* with
respect to a from-scratch analysis — it may be less precise (conservatively mark more as stale) but it
must never silently report a stale fact as fresh. The reverse-dependency fixpoint is the dependency
graph's own transitive closure restricted to edges whose resolution could change; the budget +
explicit-stale fallback is the conservative-soundness escape hatch (over-approximate the dirty set
rather than under-report it).

## Application to OpenLore

- **Dirty set** seeds from the batch's actually-changed symbols/edges, computed where
  `buildGraphSubset` already diffs the changed file (`mcp-watcher.ts:989`).
- **Reverse-dependency walk** reuses `EdgeStore.getCallerFiles` (`edge-store.ts:235`), iterated to a
  fixpoint instead of one hop, replacing the `CALLER_REPARSE_LIMIT` constant
  (`mcp-watcher.ts:60`) with a work budget.
- **Edge replacement** reuses `deleteEdgesForFile` / `deleteOutgoingEdgesForFile` / `insertEdges`
  (`edge-store.ts:324`) — applied to the closure, not just depth-1.
- **Stale-region marking** extends the graph/freshness metadata read by `makeFreshnessView`
  (`anchor-adapter.ts:83`) and consumed by `anchorFreshness` (`anchor.ts:121`).
- **Parity test** diffs the incremental graph against `analyze --force` over a fixture with a
  multi-hop `A→B→C` chain plus a newly-introduced symbol a non-caller should resolve to.

## Out of scope

- **Behavioral/runtime staleness.** This is structural-graph correctness, not test-outcome prediction.
- **Cross-repo (federation) transitive staleness.** Single-repo incremental correctness first;
  federation propagation is a separate concern.
- **Replacing the Epistemic Lease.** Time-decay still backstops *other* staleness sources (clock-age
  of a full analysis). This change removes the lease's role as cover for a *known-incorrect graph*.

## Design decisions (record before coding)

- **Converge-or-flag, in that order.** Correctness first (reverse-dependency fixpoint), explicit stale
  flag only when the work budget is exceeded. The flag is a bounded fallback, not the mechanism.
- **Soundness over precision under budget.** When uncertain or over budget, over-approximate the dirty
  region (mark more stale) rather than risk reporting a stale fact as fresh.
- **Parity with `analyze --force` is the test oracle.** The success criterion is graph equality over
  the affected region, asserted by a property test — not "looks updated."

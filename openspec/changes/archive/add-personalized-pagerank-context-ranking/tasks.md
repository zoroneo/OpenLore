# Tasks — Personalized-PageRank context ranking

> Status: IMPLEMENTED — opt-in `rankBy:"pagerank"` mode shipped on `orient` + `get_minimal_context`.
> Decision `0bdd4319` recorded (PPR as query-conditioned retrieval ranking, refines the landmark
> decision's scope to *global* salience without overturning it; no new tuning constant). Acceptance
> bar met on two real repos — see `acceptance.md` (verdict: lift demonstrated, ship opt-in). Default
> behaviour of every handler is byte-identical (verified E2E + in unit tests).

## 0. Decision gate
- [x] `record_decision`: "Personalized PageRank as query-conditioned retrieval ranking" — rationale
      (multi-path relevance shortest-path can't capture), consequences (a per-node relevance number,
      explicitly scoped to retrieval, reusing existing constants), and the relationship to the
      labeled-signals decision (refines its scope to *global salience*, does not overturn it). → verify:
      decision approved before any code.

## 1. Deterministic personalized-PageRank primitive
- [x] Implemented `personalizedPageRank` in `src/core/analyzer/personalized-pagerank.ts` —
      random-walk-with-restart over a directed weighted adjacency, restricted to a node universe.
      Damping/tolerance/iteration-cap extracted to shared `constants.ts`
      (`PAGERANK_DAMPING_FACTOR`/`PAGERANK_CONVERGENCE_TOLERANCE`/`PAGERANK_MAX_ITERATIONS`) and the
      existing file-level PageRank in `dependency-graph.ts` refactored to reference the same — single
      source of truth, no new constant. Determinism: sorted-id node iteration, sorted incoming-edge
      sum order, id tie-break in `rankByRelevance`. → verified by `personalized-pagerank.test.ts`
      (query-relative, connectivity-outranks-distance, deterministic-across-runs, no-new-constant
      source scan).
- [x] Bounded: the caller passes a `universe` (the `weightedBfs(...).keys()` distance-limited
      neighbourhood) so cost stays proportional to the task neighbourhood. → verified ("Bounded
      computation: scoring is confined to the supplied neighbourhood").

## 2. Opt-in ranking mode on handlers (default unchanged)
- [x] Added `rankBy:"distance"|"pagerank"` (default `distance`) to `handleOrient` (landmark ordering)
      and `handleGetMinimalContext` (caller/callee ordering), wired through `tool-dispatch.ts` and the
      `mcp.ts` tool schemas. No new tool; default/`minimal`/preset surfaces unchanged (payload-budget
      guard bumped as a documented, conscious decision in `mcp-presets.test.ts`).
      `suggest_insertion_points` intentionally left out of scope — its candidates are semantic-search
      results, not a graph neighbourhood. → verified ("Default output is unchanged" byte-identity in
      both handler test suites + E2E; "No new tool is added" payload-budget guard).
- [x] Seedless ⇒ no global ranking: `personalizedPageRank` returns an empty map when no seed lies in
      the universe, and the handler falls back to its default ordering. Handlers always seed on the
      target/matched-functions, so the seed set is never empty in practice. → verified ("PageRank
      requires a seed set").
- [x] Landmark/structural outputs untouched: `landmark-signals.ts` still emits labels + evidence with
      no `score`; PageRank attaches a `relevance` only to the opt-in ranked retrieval lists, never to
      landmark signals. → verified ("Landmark signals remain labels, not scores").

## 3. Token-budgeted selection
- [x] `get_minimal_context` pagerank mode fits PageRank-ranked callers/callees with the existing
      `applyTokenBudget` and reports `omittedForBudget` (counts + note) instead of truncating silently.
      → verified ("pagerank + tokenBudget fits the budget and reports omitted neighbours").

## 4. Acceptance bar (the lift must be demonstrated)
- [x] Compared on **two** real repos (OpenLore, enklayve) via `scripts/ppr-e2e.mjs` against the
      compiled handlers. **Lift demonstrated** — written up in `acceptance.md`: for hubs/orchestration
      spines, distance returns interchangeable direct siblings while PageRank surfaces the convergence
      points reached by many independent paths (e.g. `validateDirectory` → `dispatchTool`; `el` →
      `mountApp`/`renderRoute`). Honestly scoped: marginal on low-degree targets — hence opt-in. Ship.

## 5. Regression & docs
- [x] Default (non-PageRank) handler results are byte-identical to pre-change behaviour — asserted in
      unit tests (`JSON.stringify` equality, omitted vs explicit `distance`) and re-confirmed E2E on
      both repos.
- [x] `npx vitest run src examples` green: 179 files, 3,687 passed / 2 skipped. CI-protected guards
      live in plain `*.test.ts` under `src`.
- [x] E2E through the compiled handlers on really-analyzed repos: `orient` and `get_minimal_context`
      in PageRank mode return deterministic, budget-fitted, seed-relative results; default unchanged
      (`scripts/ppr-e2e.mjs`, all checks PASS on OpenLore + enklayve).

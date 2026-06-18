# Acceptance — does PPR ranking beat the distance ranker? (the gating comparison)

> Task 4 of `tasks.md`: "On ≥2 real repositories, compare PageRank-mode retrieval against the
> existing distance ranker… if no lift, do not ship." This is the written comparison.
> **Verdict: lift demonstrated — ship as opt-in.**

## Method

Both rankers were driven through the **compiled** handlers (`dist/`) via
`scripts/ppr-e2e.mjs`, which calls `get_minimal_context` and `orient` in default
(`rankBy:"distance"`) and opt-in (`rankBy:"pagerank"`) modes on a really-analyzed repo,
and reports where the two orderings disagree. Two repositories, analyzed with this build:

- **OpenLore** itself — 1,907 functions / 9,888 internal edges (TypeScript, server/CLI).
- **enklayve** — 1,923 functions (TypeScript, browser/DOM UI), analyzed `--no-embed`.

Every run also confirmed the invariants the spec requires (all PASS on both repos):
default output byte-identical to pre-change, pagerank deterministic across runs, relevance
attached only in pagerank mode, token budget fits + reports `omittedForBudget`,
seed-relativity (different targets ⇒ different relevance vectors).

## The lift (concrete, both repos)

The pattern is the same on both corpora and it is exactly the proposal's thesis —
**for a widely-used hub, the distance ranker returns interchangeable direct siblings
(all at distance 1, tie-broken by fanIn), while PageRank surfaces the orchestration/entry
spine that reaches the target through many independent paths.**

`get_minimal_context("validateDirectory")` — OpenLore (fanIn 58):
- distance callers: `handleOrient, handleAnalyzeImpact, handleSearchCode, handleSearchSpecs, handleGetCallGraph`
  — five interchangeable leaf MCP handlers, indistinguishable by call-distance.
- pagerank callers: `dispatchTool, handleRequest, startServe, execute, handleGenerateChangeProposal`
  — **`dispatchTool` is the convergence point** through which (almost) every handler reaches
  `validateDirectory`; `handleRequest`/`startServe`/`execute` are the entry roots. For "who
  really depends on this hub," the convergence point is more informative than another sibling.

`get_minimal_context("dispatchTool")` callees — OpenLore (fanOut 57):
- distance: `handleOrient, handleStructuralDiff, handleDetectChanges, handleFindDeadCode, …`
  — the first dispatch targets by distance/fanOut.
- pagerank: `validateDirectory, readCachedContext, readOpenLoreConfig, fileExists, …`
  — the **shared utilities every dispatched handler calls**, reached by many paths. For
  "minimal context to modify the dispatcher," the shared helper spine is the better frame.

`get_minimal_context("el")` callers — enklayve (DOM helper, fanIn 172):
- distance: `option, field, tryExampleButton, resultCard, assumptionHint` (sibling components).
- pagerank: `mountApp, renderRoute, renderHome, homeBudgetWidget, renderDebts` — the app
  mount/render roots that reach `el` through many component paths.

`get_minimal_context("parseNonNegative")` callers — enklayve (parse util, fanIn 122):
- distance: `renderLots, renderEvents, readFields, collect` (direct readers).
- pagerank: `mountHealthPlan, mountCashFlow, mountFafsaSai, mountLotPicker, mountPeaceOfMind`
  — the feature mount-points that pull the parser in through many form-field paths.

`orient` task-scoped landmarks — OpenLore:
- distance: nearest event-site collectors by call-distance.
- pagerank: promotes the high-connectivity hubs (`build`, `findEnclosingFunction`) the task
  is connected to by many paths, each with an explicit `relevance` value.

## Honest scoping

- The lift is **concentrated on multi-path topology** — hubs and orchestration spines, where
  many candidates tie at the same shortest distance and PageRank's connectivity weighting is
  what breaks the tie meaningfully. This is precisely where the distance ranker is weakest
  (a flat tie-break by fanIn) and where token-budgeted retrieval most needs a real priority.
- On **low-degree targets** (e.g. `compute`, 2 callers) the two orderings differ only by a
  swap or not at all — PageRank neither helps nor hurts there. That is the expected, honest
  result and the reason this ships **opt-in**, not as the default: it earns its place exactly
  on the hubs, and changes nothing for everyone else.

## Conclusion

PageRank-mode retrieval selects materially more relevant context than the distance ranker on
the cases that matter (hubs, orchestration spines, token-budgeted hub neighbourhoods), on two
independent real repositories, while leaving default behaviour byte-identical. The lift is
real, the cost is opt-in, and no tuning constant was introduced. **Ship.**

# Personalized-PageRank context ranking (query-conditioned retrieval)

> Status: IMPLEMENTED — opt-in `rankBy:"pagerank"` mode on `orient` + `get_minimal_context`; decision
> `0bdd4319` recorded; acceptance lift demonstrated on two real repos (see `acceptance.md`); default
> behaviour byte-identical. See `tasks.md` for the per-step record.
> One sentence: **add an opt-in, deterministic personalized-PageRank ranker that, seeded by a task's
> matched symbols, orders candidate functions for token-budgeted context retrieval — capturing
> multi-path relevance that the current shortest-path ranker cannot — while reusing the damping
> constant the tool already commits to and introducing no global "salience score".**

> ⚠️ **This change carries a real, documented architectural tension** with the
> `add-structural-landmark-salience` decision (no blended scores, no new tuning constants). The tension
> is addressed head-on in the next section and MUST be resolved via `record_decision` before any code.
> Do not implement this silently.

## The tension, stated first and honestly

The navigation change set made a deliberate, recorded decision (`changes/README.md:66-79`,
`archive/add-structural-landmark-salience/proposal.md:21-26`):

> "`add-structural-landmark-salience` returns **labeled signals** … **not** a blended composite
> salience score. A single weighted number would be deterministic but arbitrary — a tuning knob the
> north star exists to exclude." … "No composite/weighted salience score or any new tuning constant
> (centrality cutoffs, salience weights)."

Personalized PageRank produces exactly one number per node and the textbook algorithm carries a damping
constant. Taken naively, it is the thing that decision rejected. **Two honest facts must be on the
table before anyone approves this:**

1. **The existing ranker already does deterministic, query-seeded ordering with no tuning constant.**
   `orient` and `get_minimal_context` rank candidates by weighted call-distance — `weightedBfs` /
   `buildWeightedAdjacency` Dijkstra from task-matched seeds, tie-broken by id
   (`orient.ts:561-619`, `analysis.ts:907-996`, `graph.ts:182-236`). So this change must *beat* a
   working, knob-free ranker, not fill a vacuum.

2. **PageRank measures something shortest-path provably cannot.** Distance ranks a candidate by its
   single cheapest path to the seeds. Personalized PageRank (random-walk-with-restart to the seed set)
   ranks by **how many ways, and how densely, a candidate is connected to the task** — a function
   reachable from the seeds by many independent paths outranks one reachable by a single long path,
   even at equal shortest distance. For "pull the most task-relevant functions into a fixed token
   budget," connectivity-weighted relevance is a better objective than nearest-first. This is precisely
   why Aider's repo-map uses personalized PageRank rather than BFS distance.

**The resolution this proposal commits to** (to be ratified by `record_decision`):

- **It is retrieval ranking, not salience.** PageRank here is *query-conditioned* — seeded by the
  agent's task symbols — and is used only to order candidates for token-budgeted context selection. It
  is a different category of artifact from the *global* `hub`/`chokepoint`/`volatile` salience labels
  the landmark decision governs. It does **not** add a `score` to landmark/structural outputs and does
  **not** replace labeled signals; those remain labels, ranking-is-the-caller's, untouched.
- **It introduces no new tuning constant.** The damping factor is **reused** from the PageRank OpenLore
  already ships (`dependency-graph.ts:183`, `d = 0.85`) and the convergence tolerance is reused from
  that same implementation (`1e-6`, `dependency-graph.ts:516`). No new arbitrary weight is invented;
  the change commits to constants the codebase has already committed to.
- **It must demonstrate its lift.** The change is gated on showing, on real repos, that PPR ranking
  selects better context than the existing distance ranker for representative tasks; if it does not, it
  is not worth the added surface and should not ship. This is written as an explicit acceptance bar,
  not a nicety.
- **It is opt-in and replaces nothing by default.** It is a ranking *mode*, not a new tool, and the
  default behavior of every handler is unchanged.

If the reviewer concludes the distance ranker is sufficient, the correct outcome is to **reject this
change**, not to weaken the landmark decision. The proposal is written so that decision is informed.

## Why (given the tension is resolved)

OpenLore's job for a coding agent is to put the *right* functions in front of it within a tight token
budget. The current selectors do this two ways, both with real limits:

- **Hard count caps.** `orient` slices the top 6 landmarks (`ORIENT_LANDMARK_LIMIT`,
  `orient.ts:~610`); `suggest_insertion_points` slices a fixed limit (`semantic.ts:370-371`). A count
  cap ignores how large each item is — six big functions can blow a budget that twelve small ones fit.
- **Shortest-path-only relevance.** `get_minimal_context` ranks by distance then `fanIn`
  (`analysis.ts:964`), which, as above, misses connectivity-weighted relevance.

A query-conditioned PageRank, fed into the **token-budget mechanism that already exists**
(`applyTokenBudget`, `progressive.ts:34`, costed by `estimateTokens`, `llm-service.ts:539`), produces a
relevance-ordered, budget-fitted set: rank by task-relative connectivity, then greedily fill the budget
and report what did not fit. This is the Aider repo-map pattern, grounded on OpenLore's real call graph
(1,839 functions / 9,368 edges, far richer than Aider's file-level reference graph), and computed with
the determinism discipline OpenLore's iterative algorithms already follow.

## What changes

1. **A deterministic personalized-PageRank primitive over the in-memory call graph.** Seeded by a
   personalization vector concentrated on the task/query-matched symbols (the same seed set `orient`
   already computes for distance ranking), it runs power iteration to the existing tolerance and
   returns a query-relative relevance value per node. Determinism follows the in-tree precedent set by
   label-propagation community detection (`call-graph.ts:3421-3476`): **sorted-id node iteration order**
   each pass (`:3442`) and **id tie-break** on equal values (`:3454`). It reuses the damping constant
   and tolerance from the existing file-level PageRank (`dependency-graph.ts:183,516`).

2. **An opt-in ranking mode on retrieval handlers — not a new tool.** `orient` and
   `get_minimal_context` (and optionally `suggest_insertion_points`) gain an opt-in mode that ranks
   candidates by personalized PageRank instead of (or layered with) call-distance. With the mode
   unset, these handlers behave exactly as today.

3. **Token-budgeted selection with explicit overflow reporting.** When a token budget is supplied,
   PPR-ranked candidates are fitted via the existing `applyTokenBudget` (`progressive.ts:34`); what is
   dropped for budget is reported rather than silently truncated (the repomix "budget signals overflow,
   does not silently cut" lesson). The token estimate reuses `estimateTokens` (`llm-service.ts:539`).

4. **Bounded computation for scale.** PPR runs over a distance-bounded neighborhood of the seeds
   (reusing `weightedBfs`'s `maxDistance` pruning, `graph.ts:182-236`) rather than the full graph when
   the graph is large, so cost stays proportional to the task neighborhood, not the repository.

## What does NOT change

- **The labeled-signals decision stands.** This adds no `score` to `get_landmarks`/structural outputs,
  does not blend `hub`/`chokepoint`/`volatile`, and does not replace labels with a number. Global
  salience remains labeled signals, ranking-is-the-caller's (`landmark-signals.ts:5-9,42`).
- **No new tuning constant.** Damping and tolerance are reused from the existing PageRank
  (`dependency-graph.ts:183,516`); the seed set is the one `orient` already computes; no new weight is
  introduced.
- **Default behavior of every handler is unchanged.** PPR ranking is opt-in; `orient`,
  `get_minimal_context`, and `suggest_insertion_points` produce their current output when the mode is
  not requested. The existing distance ranker is retained, not removed.
- **No new MCP tool, and no change to the default/`minimal`/preset tool surface.** It is a ranking mode
  on existing tools (the preferred shape per `mcp-quality` and `changes/README.md:57-64`); it adds zero
  tools to consider.
- **No LLM.** PageRank is a deterministic graph computation; the only token-count input is the existing
  char-class estimate, already shipped for `search_code`.
- **No new external dependency, service, or network call.**

## Research basis

- **Aider repo-map** — `aider.chat/docs/repomap.html`, `2023/10/22/repomap.html`. Personalized
  PageRank over a code reference graph, personalized to the chat/mentioned symbols, distributed to
  definitions, then **token-budgeted by binary search**. The canonical demonstration that PPR is the
  right ranker for token-scoped code context, and that personalization (seed = the task) is what makes
  it task-relative rather than a global importance prior.
- **"World Model as a Graph: Learning Latent Landmarks for Planning"** (Zhang, Yang, Stadie; ICML 2021;
  arXiv:2011.12491) — the navigation set's existing research basis (`changes/README.md`): sparse,
  goal-conditioned navigation over a graph. PPR seeded by the goal symbols is the retrieval analogue.
- **Random-walk-with-restart / personalized PageRank** — the standard result that PPR relevance
  rewards multi-path connectivity to the seed set, distinct from shortest-path distance; this is the
  formal basis for claim 2 in the tension section.
- **repomix** — `github.com/yamadashy/repomix`: token budget as an overflow signal, not a silent
  truncation. Adopted for the budgeted-selection behavior.

## Application to OpenLore

- **Seed set** reuses the task-symbol matching `orient` already performs for distance ranking
  (`orient.ts:561-619`).
- **Determinism** mirrors label-propagation (`call-graph.ts:3439-3457`): sorted-id iteration,
  deterministic tie-break.
- **Constants** reuse the existing PageRank's damping/tolerance (`dependency-graph.ts:183,516`); the
  existing power-iteration structure (`dependency-graph.ts:480-524`) is the implementation template,
  generalized to a personalization vector and the function-level graph.
- **Budgeting** reuses `applyTokenBudget` (`progressive.ts:34`) and `estimateTokens`
  (`llm-service.ts:539`).
- **Bounding** reuses `weightedBfs` distance pruning (`graph.ts:182-236`).

## Out of scope

- **Any global salience score.** This change is query-conditioned retrieval ranking only; it never
  emits a task-independent importance number.
- **Replacing the distance ranker.** The existing `weightedBfs` ranking stays as the default; PPR is an
  alternative mode, kept only if it demonstrably wins.
- **A binary-search token fitter.** Aider binary-searches the cut; OpenLore reuses its existing greedy
  `applyTokenBudget`. A binary-search fitter is a possible later refinement, not part of this change.
- **A real tokenizer.** Budgeting reuses the existing char-class `estimateTokens`; swapping in a real
  tokenizer is a separate concern.
- **New tuning constants of any kind.** If the implementation appears to need a new weight, that is a
  signal to stop and reconsider against the landmark decision, not to add the weight.

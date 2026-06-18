# mcp-handlers spec delta

## ADDED Requirements

### Requirement: QueryConditionedPageRankRanking

The system SHALL provide a deterministic personalized-PageRank ranker over the call graph, seeded by a
personalization vector concentrated on a task's matched symbols, producing a query-relative relevance
ordering of candidate functions for context retrieval. The ranker SHALL be deterministic: it SHALL
iterate nodes in a fixed sorted order, converge to a fixed tolerance, and break ties on equal relevance
by a stable key, producing identical output for identical inputs across runs. The ranker SHALL NOT use
an LLM. It SHALL NOT introduce any new tuning constant: its damping factor and convergence tolerance
SHALL be the same values already used by the system's existing PageRank, and its seed set SHALL be the
task-symbol set the retrieval handlers already compute.

#### Scenario: Ranking is query-relative

- **GIVEN** the same call graph ranked with two different task seed sets
- **WHEN** personalized PageRank is computed for each
- **THEN** the two rankings differ according to the seeds, and a function densely connected to a seed
  set ranks higher when seeded by that set

#### Scenario: Connectivity outranks shortest distance

- **GIVEN** two candidate functions equidistant from the seeds, one reachable by many independent paths
  and one by a single path
- **WHEN** personalized PageRank is computed
- **THEN** the many-paths candidate ranks above the single-path candidate

#### Scenario: Ranking is deterministic across runs

- **GIVEN** the same graph and the same seed set
- **WHEN** the ranking is computed twice
- **THEN** the two rankings are identical, including the order of tied nodes

#### Scenario: No new tuning constant is introduced

- **GIVEN** the implementation of the ranker
- **WHEN** its constants are inspected
- **THEN** its damping factor and convergence tolerance match the values used by the system's existing
  PageRank, and no additional weighting constant is defined

### Requirement: PageRankIsRetrievalRankingNotSalience

The system SHALL treat personalized PageRank strictly as a query-conditioned retrieval ranker and SHALL
NOT expose it as a global, task-independent salience score. The system SHALL NOT add a composite or
PageRank-derived `score` to structural-salience outputs (such as landmark signals), SHALL NOT blend it
with the existing `hub` / `chokepoint` / `volatile` labeled signals, and SHALL NOT replace those
labeled signals. The personalized-PageRank ranking SHALL only order candidates relative to a supplied
task seed set.

#### Scenario: Landmark signals remain labels, not scores

- **GIVEN** a request for structural landmark signals
- **WHEN** the response is produced
- **THEN** it contains labeled signals with raw evidence and no PageRank-derived composite score

#### Scenario: PageRank requires a seed set

- **GIVEN** a request for personalized-PageRank ranking with no task seed set
- **WHEN** the request is handled
- **THEN** the ranker is not run as a global importance ranking; either a seed set is required or the
  handler falls back to its default ordering

### Requirement: OptInRankingModeUnchangedDefault

The system SHALL expose personalized-PageRank ranking as an opt-in mode on existing retrieval handlers
(`orient`, `get_minimal_context`, and optionally `suggest_insertion_points`) and SHALL NOT add a new
MCP tool or change the default, `minimal`, or any preset tool surface for it. When the mode is not
requested, each handler SHALL produce output identical to its behavior before this change, using the
existing distance-based ranker. The existing distance-based ranker SHALL be retained, not removed.

#### Scenario: Default output is unchanged

- **GIVEN** an `orient` or `get_minimal_context` request without the PageRank ranking mode
- **WHEN** the request is handled
- **THEN** the result is identical to the result produced before this change

#### Scenario: No new tool is added

- **GIVEN** the MCP tool registry after this change
- **WHEN** the default and `minimal` tool surfaces are inspected
- **THEN** they contain the same tools as before, with PageRank exposed only as a mode on existing
  tools

### Requirement: TokenBudgetedPageRankSelection

When a token budget is supplied with a PageRank-ranked retrieval request, the system SHALL select
candidates in PageRank-relevance order until the budget is reached, using the existing token-budget
mechanism and token estimate, and SHALL report which candidates were omitted for budget rather than
silently truncating the result.

#### Scenario: Selection fits the budget and reports overflow

- **GIVEN** a PageRank-ranked candidate list whose full content exceeds a supplied token budget
- **WHEN** budgeted selection runs
- **THEN** the highest-ranked candidates that fit are returned and the response indicates that
  lower-ranked candidates were omitted for budget

#### Scenario: Bounded computation on a large graph

- **GIVEN** a large repository and a task seed set
- **WHEN** personalized PageRank is computed for ranking
- **THEN** the computation is bounded to a distance-limited neighborhood of the seeds rather than the
  entire graph, and remains deterministic

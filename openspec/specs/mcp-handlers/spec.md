# MCP Handlers Specification

> Behavioural requirements for specific MCP tool handlers (`src/core/services/mcp-handlers/*`)
> beyond the cross-cutting tool-quality rules in `mcp-quality`. Tool output classification and the
> conclusion-over-graph contract live in `mcp-quality`; this domain captures handler-specific
> navigation semantics.

## Requirements

### Requirement: CoarseToFineMapNavigation

The system SHALL expose a two-tier map of the call graph: a region tier where each community is a
single super-node with aggregated inter-region super-edges, and a function tier reached by drilling
into one region. The region tier SHALL be derivable without reading any function body, and drilling
in SHALL reuse the existing community-membership view. The region tier SHALL ship in the opt-in
`navigation` preset, not the minimal default surface.

#### Scenario: Region view returns super-nodes and super-edges only

- **GIVEN** an analyzed repository with multiple communities
- **WHEN** `get_map` is called without a community id
- **THEN** the response contains one super-node per community (label, member count, top files, top
  landmark) and super-edges weighted by inter-region call count, and contains no individual function
  bodies

#### Scenario: Drilling into a region returns its functions

- **GIVEN** a community id from the region view
- **WHEN** `get_map` is called with that id
- **THEN** the response is the function-granularity view of that community, equivalent to
  `get_cluster`

#### Scenario: Large maps disclose truncation

- **GIVEN** a repository with more communities than the region-view bound
- **WHEN** the region view is produced
- **THEN** it returns the top regions by size, sets a `truncated` flag, and reports how many regions
  were omitted (no silent capping)

### Requirement: GoalConditionedLandmarkPathfinding

The system SHALL provide a `find_path` tool that accepts `from` and `to` endpoints expressed as exact
names or as selectors (`landmark:<id>`, `role:entrypoint|hub|sink`, `file:<path>`), resolves them to
concrete functions, and returns the single cheapest call path between them with a bounded set of
alternates and a stated reason. Path cost SHALL use call-distance when available and hop-count
otherwise. The tool SHALL ship in the opt-in `navigation` preset, not the minimal default.

Each `role` selector SHALL resolve through an existing deterministic classifier and SHALL NOT
introduce a new threshold: `entrypoint` = the graph's entry points; `hub` = the existing critical-hub
set; `sink` = a call-graph leaf that is actually called, defined as **zero outgoing internal call
edges AND fan-in ≥ 1** (parameter-free — no "high fan-in" or "leaf-ish" cutoff).

#### Scenario: Role-based endpoints resolve and route

- **GIVEN** a request for `from = role:entrypoint`, `to = file:src/db/writer.ts`
- **WHEN** `find_path` is invoked
- **THEN** each endpoint resolves to concrete functions and the response returns the cheapest path
  from a resolved entry point to a function in that file, with `resolvedFrom`/`resolvedTo` shown

#### Scenario: Sink selector is parameter-free

- **GIVEN** a function with zero outgoing internal call edges and at least one caller, and another
  leaf function with no callers
- **WHEN** `to = role:sink` is resolved
- **THEN** the first function resolves as a sink and the uncalled leaf does not, using only the
  existing leaf classifier and fan-in ≥ 1 — with no tunable threshold

#### Scenario: Cheapest path reflects edge cost

- **GIVEN** a short weakly-resolved path and a longer strongly-resolved path between two endpoints
- **WHEN** `find_path` runs with call-distance enabled
- **THEN** it selects the strongly-resolved path and reports its distance and hops; with call-distance
  disabled it selects the fewest-hops path

#### Scenario: No path is an explicit answer

- **GIVEN** two endpoints with no call path within the depth/distance budget
- **WHEN** `find_path` is invoked
- **THEN** it returns a structured "no path within budget" result stating how far the search reached,
  not an empty list

#### Scenario: Response is conclusion-shaped

- **GIVEN** any successful `find_path` invocation
- **WHEN** the response is produced
- **THEN** it contains the chosen path chain plus at most a bounded number of alternates, and no
  unbounded node-and-edge dump

### Requirement: BuildTheMcpLivedataTestHarnessAsAnIntegrationonlyBehaviorneutralVerificationLayer

The system SHALL verify every registered MCP tool against real codebases via a live-data integration harness, with a static coverage gate ensuring all tools have driver entries even when offline.

> Decision recorded: f4bb8a8f
> Date: 2026-06-10
### Requirement: ComputeCfgdefuseOverlayInsideLivetreeExtractorsExtendReturnContractToNodesRawedgesCfg

The system SHALL compute intraprocedural control-flow graphs and reaching-definition def-use edges inside language extractors while the parse tree is live, storing the overlay in the database only.

> Decision recorded: c8f2b9bf
> Date: 2026-06-12
### Requirement: AnchorPersistedMemoryToCallgraphSymbolsWithDeterministicFreshness

The system SHALL anchor persisted memories to call-graph symbols and compute deterministic fresh/drifted/orphaned verdicts on recall without LLM inference.

> Decision recorded: 34b178df
> Date: 2026-06-16
### Requirement: CodeanchoredMemoryStoreIsSeparateFromTheDecisionStore

The system SHALL persist agent memories in a dedicated store (.openlore/memory/notes.json) separate from the decision store, and SHALL surface both memory kinds through the recall tool with per-anchor freshness verdicts.

> Decision recorded: 517ab4c6
> Date: 2026-06-16
### Requirement: OrphanedMemoriesAreNeverServedAsAuthoritativeContext

The system SHALL The recall tool SHALL partition returned memories into authoritative and needsReanchoring sets, and SHALL never include orphaned memories in the authoritative set.

> Decision recorded: dbe6a95e
> Date: 2026-06-16

### Requirement: AuthoritativeRecallInvariant

The system SHALL guarantee, as a single named and test-enforced invariant, that **no
memory whose freshness verdict is `drifted` or `orphaned` ever appears in an authoritative
recall path unlabeled**. The authoritative recall paths are the `recall` tool and the
memory (decision) section of `orient`. An `orphaned` memory SHALL be fully withheld from
the authoritative set (surfaced only under `needsReanchoring` / `staleDecisions`); a
`drifted` memory MAY remain in the authoritative set only when it carries an explicit
`verify` label. This invariant is the operational definition of the project promise:
*OpenLore never serves an unverified or stale fact as authoritative.* It SHALL be enforced
by a property-based test (`memory-invariant.test.ts`) that generates arbitrary memories and
arbitrary code mutations and asserts the property holds for every generated case.

#### Scenario: A drifted memory is excluded from the authoritative set unlabeled

- **GIVEN** a memory whose anchor verdict is `drifted`
- **WHEN** `recall` or `orient` produces its response
- **THEN** the memory does not appear in the authoritative set unlabeled; it is withheld or
  carries an explicit verify/non-authoritative label

#### Scenario: The invariant holds under generated mutation

- **GIVEN** an arbitrary memory and an arbitrary mutation to the code it anchors
- **WHEN** the authoritative recall path is computed
- **THEN** the authoritative set contains only `fresh` memories and explicitly-labeled
  `drifted` ones, never an `orphaned` memory

### Requirement: FreshnessFailsSafeTowardDistrust

The freshness computation (`anchorFreshness`, `hashSpan`) SHALL fail safe toward distrust:
any ambiguity, hash collision, or boundary error SHALL bias the verdict toward `drifted` or
`orphaned`, never toward a false `fresh`. A renamed, moved, or deleted symbol SHALL yield
`orphaned` (or `drifted` only when a confident relocation is established). `hashSpan` SHALL
slice spans by byte offset so multibyte UTF-8 boundaries hash correctly. A test that
produces a false `fresh` SHALL be treated as a correctness failure; a false `orphaned` is
acceptable. This is guarded by the adversarial suite (`anchor-adversarial.test.ts`).

#### Scenario: A forced collision does not produce false fresh

- **GIVEN** two distinct source spans
- **WHEN** freshness is computed for a memory anchored to one after the other replaces it
- **THEN** the verdict is `drifted` or `orphaned`, never `fresh` (distinct spans do not
  collide on the truncated content hash; a collision would fail the suite loudly)

#### Scenario: A multibyte span boundary hashes correctly

- **GIVEN** an anchored span whose start or end falls on a multibyte UTF-8 boundary
- **WHEN** `hashSpan` computes the content hash before and after an unrelated edit elsewhere
- **THEN** the hash is byte-correct and stable, producing `fresh` only when the span bytes
  are unchanged

### Requirement: ConcurrentMemoryWriteSafety

The `remember` and `record_decision` tools SHALL be safe under concurrent invocation: two
concurrent writes to the same store SHALL NOT cause either write to be lost. On a write
conflict the system SHALL re-read the current store and re-apply the pending
append/upsert (compare-and-swap on a monotonic `sequence`), rather than overwrite the
competing write.

#### Scenario: Concurrent remember calls lose no write

- **GIVEN** N concurrent `remember` calls against the same memory store
- **WHEN** all calls complete
- **THEN** the persisted store contains all N memories

### Requirement: DecisionsCarryStructuralAnchorsForSelfinvalidation

The system SHALL resolve structural anchors against the call graph when recording a decision, falling back to file-level anchors when no analysis is available.

> Decision recorded: 10e6a55e
> Date: 2026-06-16
### Requirement: ValuelevelImpacttraceFallsBackToFunctionGranularityOnIllposedQueriesInsteadOfReportingZero

The system SHALL fall back to function-granularity impact when a value-level query target cannot be resolved in the overlay, reporting applied:false with a reason rather than an empty narrowed result.

> Decision recorded: a37d851f
> Date: 2026-06-16
### Requirement: DowngradeStableidMoveConfidenceFromExactToStableidWithVerifySemantics

The system SHALL report cross-file stable-id matches with confidence 'stable-id' and instruct the consumer to verify, rather than asserting the match is exact.

> Decision recorded: a3ede102
> Date: 2026-06-16
### Requirement: AnchorStableidParametergroupDetectionToTheSymbolsOwnNameNotTheFirstParenthesis

The system SHALL anchor stableId parameter-group detection to the symbol's own name so that body edits never alter the identifier.

> Decision recorded: 52b10e56
> Date: 2026-06-16
### Requirement: PersonalizedPagerankAsQueryconditionedRetrievalRankingNotGlobalSalience

The system SHALL support an opt-in personalized-PageRank ranking mode for query-conditioned retrieval in orient and get_minimal_context, seeded by task-matched symbols rather than global salience.

> Decision recorded: 0bdd4319
> Date: 2026-06-16

### Requirement: EpistemicLeaseEmitsNeutralFreshnessFactsNotCoerciveImperatives

The system SHALL surface epistemic-lease freshness as neutral factual signals (elapsed time, cognitive load, index-behind-HEAD) rather than imperative commands directed at the consuming agent.

> Decision recorded: 8e95746d
> Date: 2026-06-16
### Requirement: UseADeterministicFieldweightedRankerForRecallNoLearnedModel

The system SHALL rank recalled memories using a deterministic field-weighted scoring algorithm with identifier-aware normalization, without requiring LLM inference or embedding lookups.

> Decision recorded: 08005eb9
> Date: 2026-06-18

### Requirement: ConfidenceBoundaryOnConclusions

Every conclusion-shaped answer (`analyze_impact`, `find_path`, `find_dead_code`, `get_subgraph`,
`select_tests`, `recall`, `trace_execution_path`) SHALL carry a deterministic `confidenceBoundary`
describing its epistemic basis: the portion resting on directly-resolved edges, the portion resting on
synthesized edges (named by their `synthesizedBy` rule), and any **known-unknowable** crossings — a
traversal that passed a reflection or computed-dispatch boundary, or, under federation, an unindexed
repository. The boundary SHALL be categorical labels and counts, never a blended confidence score, and
SHALL be additive metadata that callers may ignore. It SHALL be computed without an LLM, from the
edge `confidence`/`synthesizedBy` provenance already present (decision `08e71184`).

#### Scenario: A clean answer reports a clean boundary

- **GIVEN** a query answered entirely via directly-resolved edges against a current index
- **WHEN** the response is produced
- **THEN** its `confidenceBoundary` reports only directly-resolved basis, no known-unknowable crossing,
  and `complete: true`

#### Scenario: A boundary-crossing answer is flagged, not hidden

- **GIVEN** a `find_dead_code` query whose liveness partition is reached only across a synthesized
  (heuristically-recovered dispatch) edge
- **WHEN** the response is produced
- **THEN** the `confidenceBoundary` names the synthesized crossing as known-unknowable, breaks down the
  synthesized edges by rule, and reports `complete: false`

### Requirement: StalenessBoundary

When graph-relevant source files have changed since the index's build commit, every conclusion SHALL
carry a staleness marker naming that build commit and the count of source files changed since it,
derived deterministically from `git diff` against the commit captured at analyze time. A current index
(zero source files changed) SHALL produce no staleness marker. When staleness cannot be assessed
reliably — no build commit was captured, or the project is not a git repository — the system SHALL
stay silent rather than emit a false-positive marker.

#### Scenario: A stale index is disclosed

- **GIVEN** an index built at commit X and a working tree with N files changed since X
- **WHEN** any conclusion is produced
- **THEN** the response discloses "computed against the index at commit X; N file(s) changed since" and
  reports `complete: false`

> Decision recorded: 08e71184
> Date: 2026-06-18

## Decisions

### Build the MCP live-data test harness as an integration-only, behavior-neutral verification layer

**Status:** Approved
**Date:** 2026-06-10
**ID:** f4bb8a8f

Spec-09 drives every tool in TOOL_DEFINITIONS against real OSS repos (pinned by URL+SHA, fetched into a gitignored cache) to catch real-world-only tool defects. The design splits responsibilities: the tool-driver registry, invariant helpers (secret/path scan, budget, shape), and the manifest are pure and tested by plain *.test.ts files that run in CI offline; the clone→init→analyze→drive pipeline lives only in *.integration.test.ts and skips with a loud log when offline. Tools are driven via the existing dispatchTool() single entry point. The static coverage gate (every TOOL_DEFINITIONS name has a driver registry entry) is the headline anti-rot guard and runs offline; the dynamic gate (every tool actually exercised) runs in the integration suite and distinguishes offline-skip from missing-driver.

**Consequences:** Adds src/core/services/mcp-handlers/live-data/ (manifest, repo-cache, analyze-repo, tool-driver, invariants, report, integration test, plain unit tests). Adds a gitignored cache dir and a test:live script. No tool handler, TOOL_DEFINITIONS, dispatch, or protocol code is modified — any defect found is recorded as a TODO(spec-09-followup), never fixed in this change. LLM-backed tools are driven in dryRun where available or skipped behind an env flag when no API key, still covered by the static registry guard.

### Compute CFG/def-use overlay inside live-tree extractors, extend return contract to {nodes, rawEdges, cfg}

**Status:** Approved
**Date:** 2026-06-12
**ID:** c8f2b9bf

Parse trees are freed per-extractor before later passes (WASM path calls tree.delete), so a CFG/def-use pass cannot run as a late pass over already-built FunctionNodes — the AST is gone. The overlay must be computed inside each extractor while the tree is live. A shared cfg.ts module builds per-function basic blocks and runs an intra-procedural reaching-definitions fixpoint to produce labeled (exact|may) def-use edges, all from AST shape with no LLM.

**Consequences:** Every in-scope extractor (TS/JS, Python, Go in v1) gains an optional cfg build call; CallGraphResult carries a transient cfgs map threaded to the DB writer. The overlay is DB-only (new tables, SCHEMA_VERSION bump 6→7) and is NOT added to SerializedCallGraph or the hot cache, so resident memory is unchanged. Unsupported languages return cfg undefined (fail-soft).

### Value-level impact/trace falls back to function granularity on an ill-posed query

**Status:** Approved
**Date:** 2026-06-14
**ID:** 313b897e

Dogfooding showed the value-level opt-in could silently report zero blast radius when valueReachableLines() returned an empty set — e.g. a mistyped valueParam that matches no parameter/local, or an "all parameters" request on a function the overlay extracted no params for. Zero downstream reads to an agent as "this change is safe," the exact failure value-level must avoid. The handlers now treat a query as well-posed only when its target resolves in the overlay (a named valueParam is a parameter or a tracked def-use variable; an unnamed request needs at least one parameter) and otherwise fall back to the full function-granularity result with an explicit reason, instead of an empty narrowed slice.

**Consequences:** analyze_impact and trace_execution_path return applied:false with a clear reason (and the full blast radius / unrestricted first hop) when the value-level target can't be resolved, rather than a misleading zero. A genuine zero — a real parameter that flows to no callee — is still reported as a sound applied:true narrowing. Regression-tested in graph.test.ts.

### Anchor persisted memory to call-graph symbols with deterministic freshness

**Status:** Approved
**Date:** 2026-06-16
**ID:** 34b178df

Every persisted memory (architectural decisions and remember-notes) carries StructuralAnchors resolved against the call graph, and recall computes a fresh/drifted/orphaned verdict from booleans only (symbol existence + content-hash equality) — no LLM, no threshold, no weighted score. This is what code-anchored memory can do that probabilistic vector memory cannot: self-invalidate when the code it describes changes or dies, so recall never serves stale context silently.

**Consequences:** New StructuralAnchor/MemoryFreshness/AnchoredMemory types and a pure anchor engine (decisions/anchor.ts) plus a disk adapter. record_decision now captures anchors. Two new opt-in MCP tools (remember/recall) in a 'memory' preset, kept out of the default/minimal surface. recall enforces a no-silent-stale guarantee (orphaned memories are never authoritative). Notes stored in .openlore/memory, isolated from the decisions gate. Wiring memory-staleness into check_spec_drift and orient is deferred.

### Code-anchored memory store is separate from the decision store

**Status:** Approved
**Date:** 2026-06-16
**ID:** 517ab4c6

Memories (durable agent notes) serve a different lifecycle than architectural decisions — they have no commit gate, no consolidation, and no spec-sync. Keeping them in .openlore/memory/notes.json avoids coupling two independent persistence concerns.

**Consequences:** Two distinct stores must be loaded and freshness-checked independently at recall time; recall merges results from both stores into one response so callers see a unified view.

### Orphaned memories are never served as authoritative context

**Status:** Approved
**Date:** 2026-06-16
**ID:** dbe6a95e

A memory whose every structural anchor points to deleted or unreachable code cannot be trusted — serving it as fact risks misleading agents into acting on stale assumptions.

**Consequences:** Recall responses partition results into `authoritative` (fresh + drifted) and `needsReanchoring` (orphaned); consumers must not treat needsReanchoring entries as ground truth.

### Decisions carry structural anchors for self-invalidation

**Status:** Approved
**Date:** 2026-06-16
**ID:** 10e6a55e

Anchoring decisions to call-graph nodes (not just file paths) lets the system detect when the described code has been refactored or deleted, enabling deterministic staleness detection without LLM inference.

**Consequences:** record_decision now depends on AnchorContext / call-graph data at recording time; if no analysis exists the decision falls back to file-level freshness, which is less precise but not a failure.

### Value-level impact/trace falls back to function granularity on ill-posed queries instead of reporting zero

**Status:** Approved
**Date:** 2026-06-16
**ID:** a37d851f

Dogfooding revealed that valueReachableLines() could return an empty set on ill-posed queries (mistyped valueParam, or 'all parameters' on a function with no overlay params), which an agent interprets as 'this change is safe' — the exact failure value-level must avoid. The handlers now validate that the target resolves in the overlay (a named valueParam is a known parameter or tracked def-use variable; an unnamed request needs at least one parameter) and fall back to full function-granularity with an explicit reason when it does not, rather than returning a misleading zero-impact narrowing.

**Consequences:** analyze_impact and trace_execution_path return applied:false with a clear reason (plus the full blast radius / unrestricted first hop) when the value-level target can't be resolved. A genuine zero — a real parameter that flows to no callee — is still reported as applied:true. Regression-tested in graph.test.ts.

### Downgrade stable-id move confidence from 'exact' to 'stable-id' with verify semantics

**Status:** Approved
**Date:** 2026-06-16
**ID:** a3ede102

A content-addressed stable id (name + parameter shape) is necessary but not sufficient to prove a symbol moved: a deleted symbol independently replaced by a same-name/same-shape homonym is indistinguishable from a genuine move. Labeling it 'exact' gave agents false certainty; 'stable-id' plus a verify directive is more honest.

**Consequences:** Agents consuming structural-diff output must treat confidence:'stable-id' as strong-but-not-proven and verify cross-file moves instead of trusting them blindly. Any downstream automation that branches on confidence === 'exact' must update to handle 'stable-id'.

### Pass language to signatureShape for heuristic rename pairing

**Status:** Approved
**Date:** 2026-06-16
**ID:** 767d5274

Signature shape comparison without language context could incorrectly pair symbols across languages that happen to share textual shape; threading the language parameter makes the heuristic language-aware.

**Consequences:** signatureShape callers must supply the language argument; cross-language false-positive rename pairings are reduced.

### Locate the stableId parameter group by the symbol's name, not the first paren

**Status:** Approved
**Date:** 2026-06-16
**ID:** 4a5c5353

signatureShape assumed the parameter group is the first `(` in the captured signature (after a Go-receiver skip). For languages whose captured signature includes the body of a paren-less definition — Ruby (`def total; compute(5); end`), Scala (`def total = compute(5)`), and paren-less arrows (`const f = a => g(a)`) — the first `(` belongs to a body call, so the body leaked into the stableId. That broke the spec's body-invariance guarantee: editing the body flipped the id, so a moved-and-edited symbol read `orphaned`/remove+add instead of `drifted`/move. Fix: parameterGroupStart is now name-anchored — the parameter group is the first `(` whose immediately preceding token is the symbol's own name (or operator name), with an assigned lambda (`= (a) =>`) recognized too. This also subsumes the Go receiver skip (the receiver `(` is preceded by `func`, not the method name) and skips arg-bearing decorators. When no name is supplied (bare unit-test calls) the legacy first-`(` heuristic is preserved, so the change is backward-compatible.

**Consequences:** stableId is now genuinely body-invariant for paren-less Ruby/Scala/arrow definitions (verified end-to-end: a paren-less Ruby method moved across files with a body edit is reported as a stable-id move, not remove+add). arityOf (SCIP monikers) shares the same name-anchored detection. All 13 supported-language stableIds are byte-identical to before (zero regressions); full suite 3673 green; audit clean. signatureShape/parameterGroupStart gain an optional trailing `name` argument.

### Anchor stableId parameter-group detection to the symbol's own name, not the first parenthesis

**Status:** Approved
**Date:** 2026-06-16
**ID:** 52b10e56

signatureShape assumed the parameter group starts at the first `(` in the captured signature (after a Go-receiver skip). For languages whose captured signature includes the body of a paren-less definition — Ruby (`def total; compute(5); end`), Scala (`def total = compute(5)`), and paren-less arrows (`const f = a => g(a)`) — the first `(` belongs to a body call, so body content leaked into the stableId. That broke the spec's body-invariance guarantee: editing the body flipped the id, causing a moved-and-edited symbol to read as remove+add instead of a stable move. Fix: the parameter group is now the first `(` whose immediately preceding token is the symbol's own name (or operator name), with assigned lambdas (`= (a) =>`) recognized too. This subsumes the Go receiver skip (receiver `(` is preceded by `func`, not the method name) and skips arg-bearing decorators. When no name is supplied (bare unit-test calls) the legacy first-`(` heuristic is preserved for backward compatibility.

**Consequences:** stableId is genuinely body-invariant for paren-less Ruby/Scala/arrow definitions; a paren-less method moved across files with a body edit is reported as a stable-id move, not remove+add. arityOf (SCIP monikers) shares the same name-anchored detection. signatureShape/parameterGroupStart gain an optional trailing `name` argument. All 13 supported-language stableIds are byte-identical to before (zero regressions).

### Personalized PageRank as query-conditioned retrieval ranking (not global salience)

**Status:** Approved
**Date:** 2026-06-16
**ID:** 0bdd4319

Shortest-path distance ranks a candidate by its single cheapest path to the task seeds; it cannot capture multi-path / connectivity-weighted relevance. Personalized PageRank (random-walk-with-restart seeded on the task's matched symbols) ranks a candidate by how many ways and how densely it is connected to the task, which is a better objective for pulling the most task-relevant functions into a fixed token budget. This is exposed strictly as an opt-in retrieval ranking mode on existing handlers (orient, get_minimal_context), seeded by the task-symbol set orient already computes — it is query-conditioned, never a global task-independent importance number. It refines the scope of the add-structural-landmark-salience decision (c6d1ad07 lineage) to global salience only; it does not overturn it. It introduces no new tuning constant — damping (0.85) and convergence tolerance (1e-6) are extracted to shared named constants with the existing PageRank in dependency-graph.ts. It must demonstrate lift over the distance ranker on >=2 real repos or be closed.

**Consequences:** Adds an opt-in rankBy: "pagerank" mode to orient and get_minimal_context; default behavior of every handler stays byte-identical and the distance ranker is retained. A new deterministic personalized-PageRank primitive is added over the in-memory call graph (sorted-id iteration, id tie-break, distance-bounded neighborhood). No new MCP tool and no change to default/minimal/preset tool surfaces. If the acceptance comparison shows no lift, the change is closed and the landmark decision is left intact.

### Epistemic lease emits neutral freshness facts, not coercive imperatives

**Status:** Approved
**Date:** 2026-06-16
**ID:** 8e95746d

The epistemic-lease feature injected escalating imperative language into every MCP tool response (STOP, "Repository model: EXPIRED", "do NOT…"). This is structurally a prompt-injection pattern — it trains agents to obey authoritative imperatives in tool output, the exact behavior agents must resist — and contradicts the north-star decision (c6d1ad07: deterministic structural facts, not guessing) and the landmark-salience principle (hand the agent facts, let it rank). Wall-clock age alone escalated to CRITICAL (false positive), and the agent's own commits flipped the lease to stale via git-hash divergence even though committing is the most-informed action in a session. Fix: emit a single neutral, factual freshness note (minutes since orient, cognitive load since orient, whether the analysis index is behind HEAD) phrased as information the agent can act on, not a command. Drive severity from accumulated cognitive load, not wall clock.

**Consequences:** staleBlock/degradedSignal reworded to neutral facts (no STOP/EXPIRED/do-NOT, no system-banner box art); git-hash divergence no longer forces stale — it sets a factual index-behind-HEAD flag and at most contributes to degraded; computeStaleDepth driven by cognitive load, not wall-clock age; decay tracking, cross-module density/oscillation model, and telemetry retained; epistemic-lease gains a spec requirement (mcp-handlers) and ADR where it previously had neither.

### Use a deterministic field-weighted ranker for recall (no learned model)

**Status:** Approved
**Date:** 2026-06-18
**ID:** 08005eb9

recall previously ranked memories by binary substring token-overlap, which silently dropped relevant memories on a phrasing mismatch (e.g. a camelCase identifier vs a plain word). Replaced it with a deterministic field-weighted, graded ranker: identifier-aware normalization (camelCase/PascalCase/snake_case/kebab-case split before lower-casing, fixed stopword set), fixed field weights (anchorSymbol 4 > tag 3 > anchorFile 2 > content 1), occurrence-capped grading, and an exact-anchor boost (8) when the query names every subtoken of an anchored symbol. This keeps the memory path LLM-free and embedding-free per the north star (decision c6d1ad07) while fixing the worst retrieval failure mode. A substring fallback (weight 0.1, applied only when the token score is zero) guarantees the candidate set is a superset of the old behavior.

**Consequences:** Weights and the stopword set are fixed, documented, exported constants — changing them is a code+test change, not a runtime knob. recall items gain an optional match {fields, anchorBoost} field for transparent ranking reasons. Embedding-backed recall is deliberately deferred to a future proposal with its own decision. The authoritative/orphaned freshness split is unchanged and still runs after ranking.

### confidenceBoundary response shape: categorical edge-basis + known-unknowable crossings + staleness, never a blended score

**Status:** Approved
**Date:** 2026-06-18
**ID:** 08e71184

Every conclusion tool (analyze_impact, find_path, find_dead_code, get_subgraph, select_tests, trace_execution_path, recall) carries a deterministic `confidenceBoundary` computed from data already present: edge `confidence`/`synthesizedBy` provenance for the basis, synthesized-edge reliance for known-unknowable crossings, and the project fingerprint + git diff for staleness. The shape is categorical labels and counts (directEdges, synthesizedEdges, synthesizedByRule, knownUnknowable[], staleness, complete) — never a blended confidence number and never an LLM call, preserving the north-star (c6d1ad07). It is additive metadata: a caller that ignores it sees today's answer unchanged.

**Consequences:** A new shared module src/core/services/mcp-handlers/confidence-boundary.ts owns the type and computation; seven conclusion handlers each spread a `confidenceBoundary` field into their response. analyze.ts's fingerprint.json gains an optional `commit` field (captured via git rev-parse at analyze time) so the staleness marker can name the build commit; staleness degrades gracefully (no commit / non-git repo → fingerprint-mismatch boolean without a commit name). `complete` is false whenever the computation leaned on a synthesized edge, crossed a known-unknowable boundary, or ran against a stale index — the answer-level NoFalseCompleteness contract.

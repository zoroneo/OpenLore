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

### Requirement: BitemporalMemoryValidity

Every memory SHALL carry, in addition to its transaction time (`recordedAt`), a deterministic
**valid-from** marker: `validFromCommit`, the `HEAD` commit SHA at the time the memory was recorded,
read from git with no LLM. When a memory is superseded it SHALL gain `invalidatedAt` and
`invalidatedByCommit`. The `recall` tool SHALL accept an optional `asOf` (commit-ish) and return the
memories authoritative as of that commit — recorded at or before `asOf` and not invalidated at or
before it — comparing valid-time via git ancestry (`merge-base --is-ancestor`), not wall-clock,
reusing the existing relevance selection unchanged. A memory whose valid-time markers cannot be
placed on the commit axis is handled fail-closed: an absent `validFromCommit` reads as recorded
before any commit (legacy memories stay always-valid), but an invalidated memory with no
`invalidatedByCommit` is treated as already-retired and excluded from every `asOf` window rather than
revived into a result we cannot prove it belonged to.

#### Scenario: A memory records its valid-from commit
- **GIVEN** a `remember` call made while `HEAD` is at commit C
- **WHEN** the memory is persisted
- **THEN** the stored memory's `validFromCommit` equals C

#### Scenario: As-of recall reflects history
- **GIVEN** a memory superseded at commit C
- **WHEN** `recall` is invoked with `asOf` earlier than C
- **THEN** the memory is returned as authoritative; and with `asOf` at or after C it is absent

> Decision recorded: 48771c59
> Date: 2026-06-18

### Requirement: ExplicitMemorySupersession

The `remember` tool SHALL accept `supersedes: <memoryId>`, marking the referenced prior memory as
invalidated. Supersession SHALL be an explicit caller act, not an inferred merge. An invalidated
memory SHALL NOT appear in any authoritative recall path (per the `AuthoritativeRecallInvariant`),
but SHALL remain retrievable via `asOf` for history.

#### Scenario: Superseding retires the prior memory
- **GIVEN** memory M1 and a later `remember` call declaring `supersedes: M1`
- **WHEN** `recall` runs without `asOf`
- **THEN** M1 does not appear in the authoritative set and the new memory does

### Requirement: DeterministicContradictionSurfacing

When two authoritative (`fresh`, non-invalidated) memories resolve to the same anchor symbol,
`recall` and `orient` SHALL surface the pair as `unreconciled` — a conclusion-shaped signal that two
grounded memories describe the same symbol and should be reconciled or one superseded. The system
SHALL NOT silently present both as independent fact, and SHALL NOT use an LLM to choose between them.
The signal SHALL be a pure set intersection over symbol-level anchors (file-level anchors are too
coarse to count).

The detection SHALL reflect the recall's active scope: it is computed over the set the query already
selected, so a `task` (score) or `type` filter narrows the memories considered (e.g. a cross-type
contradiction is not flagged under a `type` filter). An unfiltered `recall` (no task, no type) is the
store-wide guarantee. `orient` surfaces the signal scoped to the task's relevant and decision-governed
files and only when the call-graph view is available — without an edge store it cannot verify
freshness, so it surfaces nothing rather than guess; `recall` is the unscoped path.

#### Scenario: Two fresh memories on one symbol are flagged
- **GIVEN** two authoritative memories whose anchors resolve to the same symbol
- **WHEN** an unfiltered `recall`, or `orient` with a graph view, produces its response
- **THEN** the pair is reported as `unreconciled`, not served as two independent authoritative facts

### Requirement: TypedMemoryClassification

The `remember` tool SHALL accept an optional `type` from a fixed, closed set — `invariant`, `gotcha`,
`rationale`, `convention`, `preference`, `todo`, `note` — defaulting to `note` when absent or
unrecognized. The type SHALL be a caller-supplied label; the system SHALL NOT infer, classify, or
override it. The `recall` tool SHALL accept an optional `type` filter that restricts results to
memories of that type. Legacy memories with no stored type SHALL behave as `note`.

#### Scenario: Type is stored as given and filters recall
- **GIVEN** a `remember` call with `type: "invariant"` and another with `type: "todo"`
- **WHEN** `recall` is invoked with a `type: "invariant"` filter
- **THEN** only the `invariant` memory is returned, and an absent/unknown type reads as `note`

### Requirement: ChangedSinceRecall

The `recall` tool SHALL accept an optional `changedSince` (commit-ish) that returns the memories
recorded or invalidated after that commit, reusing the bitemporal fields with no new relevance model.
With no `task` the result is ordered most-recent first (record-time descending); when a `task` is
given its relevance score ranks first and record-time is the tiebreak. The boundary is exclusive: a
memory recorded *at* `changedSince` is not returned. A memory whose record or invalidation commit
cannot be placed on the commit axis (no `validFromCommit` / `invalidatedByCommit`) is fail-closed out
of the differential rather than guessed in. This is the differential companion to `asOf`.

#### Scenario: Differential recall returns only later changes
- **GIVEN** memory M1 recorded at commit C1 and memory M2 recorded at commit C2 (C2 after C1)
- **WHEN** `recall` is invoked with `changedSince` set to C1
- **THEN** M2 is returned and M1 is not

### Requirement: ContentAnchorDedup

The `remember` tool SHALL key a memory's identity on a hash of its content together with its resolved
anchors, so that re-recording the same content about the same code updates the existing memory in
place rather than creating a second record. Dedup SHALL be exact hash equality; the system SHALL NOT
merge distinct memories or judge relative importance.

#### Scenario: Re-recording identical content does not duplicate
- **GIVEN** a memory recorded with content X and anchor A
- **WHEN** `remember` is called again with the same content X and anchor A
- **THEN** the store contains one memory for (X, A); the same content on a different anchor B is distinct
### Requirement: PreflightStructuralBriefing

The system SHALL provide a pre-flight capability that, given a staged or working diff, returns a
deterministic conclusion-shaped briefing of the change's structural blast radius: affected callers and
layers crossed, the tests to run, the anchored memories and decisions the diff will turn `drifted` or
`orphaned`, the specs it will make stale, and (under federation) the cross-repo consumers of any
changed published interface. The briefing SHALL compose existing deterministic analyses only, with no
LLM and no new structural computation, and SHALL be a briefing (counts and named risks), never a graph.

> Decision recorded: 987286eb
> Date: 2026-06-18

#### Scenario: A hub change is briefed before commit

- **GIVEN** a working diff that modifies a function with many callers and an anchored decision
- **WHEN** the pre-flight briefing is requested
- **THEN** it reports the caller count and layers, the tests to run, and that the anchored decision
  will drift — as a single conclusion-shaped briefing

### Requirement: AdvisoryByDefault

The pre-flight guard SHALL be non-blocking by default: surfaced on demand or via an advisory git hook
that does not fail a commit. A repository MAY opt into blocking for specific high-risk patterns (for
example, orphaning an anchored decision) via configuration, but blocking SHALL never be the default
posture.

#### Scenario: Default hook is advisory

- **GIVEN** the pre-flight git hook installed with default configuration
- **WHEN** a commit is made for a high-blast-radius diff
- **THEN** the briefing is emitted and the commit is not blocked

#### Scenario: Opt-in blocking fires only on its pattern

- **GIVEN** a repository configured to block when a commit orphans an anchored decision
- **WHEN** a commit would orphan an anchored decision
- **THEN** the hook blocks; and for any other high-blast-radius diff it remains advisory
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
### Requirement: ExcludeAllOpenloreprefixedDirsFromTheProjectFingerprintSoOpenloresOwnCachesDontInvalidateTheAnalysisCache

The system SHALL exclude all directories whose name starts with `.openlore` from project fingerprint computation so that OpenLore-managed caches do not invalidate analysis freshness.

> Decision recorded: cd5ff82c
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

### Name the pre-flight blast-radius guard `blast_radius` (MCP) / `blast-radius` (CLI), distinct from the existing `preflight` staleness gate

**Status:** Approved
**Date:** 2026-06-18
**ID:** 987286eb

The add-preflight-blast-radius-guard proposal is titled "pre-flight blast-radius guard," but `openlore preflight` already exists as an unrelated CI graph-staleness gate (src/cli/preflight/). Reusing the word "preflight" across both surfaces would conflate two different concerns. The new capability is named `blast_radius` everywhere to be collision-free and self-describing ("compute my diff's structural blast radius"). It is implemented as pure orchestration of existing deterministic analyses (analyze_impact, select_tests, check_spec_drift which already folds in anchored-memory + ADR drift, and getChangedFiles) composed into a single conclusion-shaped briefing — no new structural computation, no LLM. The MCP tool is classified `conclusion` and kept out of the `minimal` preset. The git hook is advisory-by-default (exit 0); opt-in blocking for named high-risk patterns reads `.openlore/config.json` `blastRadius.block`. The multi-repo-federation cross-repo-consumers input is scoped out (federation not yet shipped) and documented as a no-op with a note.

**Consequences:** A new MCP tool `blast_radius` and CLI `openlore blast-radius` (with --install-hook, --hook, --json) ship; OpenLoreConfig gains an optional `blastRadius?: { block?: string[] }` field; a new advisory pre-commit hook block (marker `# openlore-blast-radius-hook`) installs alongside the decisions hook. Federation cross-repo consumers remain a documented gap until add-multi-repo-federation lands.
### confidenceBoundary response shape: categorical edge-basis + known-unknowable crossings + staleness, never a blended score

**Status:** Approved
**Date:** 2026-06-18
**ID:** 08e71184

Every conclusion tool (analyze_impact, find_path, find_dead_code, get_subgraph, select_tests, trace_execution_path, recall) carries a deterministic `confidenceBoundary` computed from data already present: edge `confidence`/`synthesizedBy` provenance for the basis, synthesized-edge reliance for known-unknowable crossings, and the project fingerprint + git diff for staleness. The shape is categorical labels and counts (directEdges, synthesizedEdges, synthesizedByRule, knownUnknowable[], staleness, complete) — never a blended confidence number and never an LLM call, preserving the north-star (c6d1ad07). It is additive metadata: a caller that ignores it sees today's answer unchanged.

**Consequences:** A new shared module src/core/services/mcp-handlers/confidence-boundary.ts owns the type and computation; seven conclusion handlers each spread a `confidenceBoundary` field into their response. analyze.ts's fingerprint.json gains an optional `commit` field (captured via git rev-parse at analyze time) so the staleness marker can name the build commit; staleness degrades gracefully (no commit / non-git repo → fingerprint-mismatch boolean without a commit name). `complete` is false whenever the computation leaned on a synthesized edge, crossed a known-unknowable boundary, or ran against a stale index — the answer-level NoFalseCompleteness contract.

### Confidence-boundary staleness uses git-diff against the build commit, not a fingerprint-hash recompute

**Status:** Approved
**Date:** 2026-06-18
**ID:** f0b7f99f

Comparing the analyze-time project fingerprint (whole-tree mtime+size hash) against a query-time recompute is unreliable: fixture dirs and mtime drift cause false-positive staleness on every answer, training agents to ignore the marker. Replaced with a deterministic git signal: staleness fires iff `git diff --name-only <buildCommit>` reports graph-relevant source files changed since the index was built. Non-git repos and indexes with no captured commit get NO staleness marker (silent rather than false-positive) — a deliberate honesty tradeoff. This supersedes the "fingerprint-mismatch boolean" degradation described in decision 08e71184 above.

**Consequences:** computeStaleness no longer calls computeProjectFingerprint; it reads the build commit from fingerprint.json and shells `git diff` (memoized 5s per dir). A pure buildStalenessMarker(commit, changedCount) holds the emit/silent logic and is unit-tested. The pre-existing fingerprint-includes-.openlore-live-cache bug that affects isCacheFresh is left untouched and flagged separately.

### Exclude all .openlore-prefixed dirs from the project fingerprint so OpenLore's own caches don't invalidate the analysis cache

**Status:** Approved
**Date:** 2026-06-18
**ID:** cd5ff82c

computeProjectFingerprint walked .openlore-live-cache (the gitignored clone cache for live-data fixtures). Those foreign source files churn whenever the live-data MCP tools or integration tests run, so the content hash flapped even when the user's own source was unchanged — forcing needless full re-analysis and false staleness markers. Generalizing the directory skip from exact `.openlore` to any `.openlore`-prefixed name covers `.openlore`, `.openlore-live-cache`, and future OpenLore-managed dirs in one rule.

**Consequences:** walkForFingerprint now skips directories whose name starts with `.openlore` in addition to the static FINGERPRINT_SKIP_DIRS set. The custom OPENLORE_LIVE_CACHE_DIR override (an arbitrary path) is not covered by the prefix rule — acceptable since the default is the in-repo `.openlore-live-cache`. A regression test asserts live-cache churn leaves the fingerprint unchanged while a real user-source edit still flips the hash.

### Requirement: StructuralClaimVerification

The system SHALL provide a `verify_claim` capability that accepts a structured structural claim
(`{ kind: 'calls' | 'reaches' | 'dead' | 'impacts' | 'safe-to-change', subject, object? }`) and returns
a deterministic `{ verdict: 'confirmed' | 'refuted' | 'unverifiable', reason, receipt?, confidenceBoundary }`.
The verdict SHALL be computed by the existing deterministic analysis for that claim kind (call-graph
traversal for `calls`/`reaches`, backward reachability for `impacts`, mark-and-sweep reachability for
`dead`, directly-resolved caller analysis for `safe-to-change`), never by an LLM and never as a
confidence number. A `confirmed` or `refuted` verdict SHALL carry a receipt — the subject/object spans
and content hashes (grounding-certificate shape) plus the index commit — suitable for the agent to cite
to a human. A claim whose answer rests on a dispatch blind spot (a symbol reached only through
synthesized dynamic-dispatch edges, or an unresolved/ambiguous symbol) SHALL return `unverifiable` with
the boundary named (reusing the confidence-boundary disclosure), never a fabricated `confirmed`/`refuted`.
The capability SHALL be conclusion-shaped (verdict + bounded receipt, never a graph to traverse) and
registered only in an opt-in preset (`verify`), never in the minimal or first-run default surface.

#### Scenario: A false claim is refuted with a receipt

- **GIVEN** a claim that function A calls function B, when no such edge exists
- **WHEN** the claim is verified
- **THEN** the verdict is `refuted` with a receipt referencing the index commit and the relevant spans

#### Scenario: A blind-spot claim is unverifiable, not fabricated

- **GIVEN** a `dead` claim about a symbol reachable only through synthesized dynamic-dispatch edges
- **WHEN** the claim is verified
- **THEN** the verdict is `unverifiable` with the dispatch boundary named, never `confirmed` or `refuted`

### Requirement: ProactiveIntentBriefing

`orient` SHALL, for the symbols and files in a task's scope, proactively surface relevant prior
decisions and `remember` notes as part of orientation — without the agent having to ask for history
it is unaware of. Surfaced intent SHALL include records authored by any agent or human (not only the
current session) and SHALL carry a freshness verdict per the authoritative-recall invariant: orphaned
intent is withheld from the authoritative set (segregated as stale), drifted intent is flagged to
verify. (Realized by orient's `pendingDecisions` / `staleDecisions` / `unreconciledMemories` briefing.)

#### Scenario: Orientation surfaces an in-scope constraint with its verdict

- **GIVEN** a decision anchored to a function in the task's scope
- **WHEN** `orient` runs for that task
- **THEN** the decision is surfaced in the briefing with its freshness verdict

### Requirement: ReversalAwareness

When intent in a task's scope was superseded or reverted, **`orient` and `recall`** SHALL surface it in
an additive `reversals` field as an explicit do-not-repeat warning — naming the commit at which a memory
was retired (its `invalidatedByCommit` = HEAD when the superseding memory was recorded, which is the
commit the note was retired *as of*, not a verified "this commit reverted the code" claim) and the
recorded reason (the superseding record's content/rationale) — rather than silently omitting reverted
history, because the absence of a do-not-repeat signal is what lets an agent re-introduce a deliberately
removed approach. A reverted **memory** is one with `invalidatedAt` set; a reverted **decision** is one
targeted by another, non-`rejected`/`phantom` decision's `supersedes` (a *declined* supersession leaves
the original standing). The two surfaces differ only in scope: `orient` by the task's relevant
files/domains, `recall` by task relevance (so a fully-reverted approach surfaces even with no current
memory on its file). Reverted intent SHALL NOT be re-served as authoritative current context, only as
cautionary history; a superseded decision SHALL be excluded from the authoritative set by the same
supersession predicate that surfaces it as a reversal, so the two surfaces can never disagree — including
in the pre-consolidation window where the superseded decision's own status has not yet flipped to
`rejected` (e.g. with no LLM configured). Selection is deterministic retrieval over already-recorded
supersession records; no LLM. The field SHALL be bounded with an explicit omission note (never a silent
truncation of history) and omitted entirely when nothing in scope was reverted.

#### Scenario: A reverted approach is surfaced as do-not-repeat

- **GIVEN** an approach recorded and later retired as of commit Y with a reason
- **WHEN** an agent orients on the code that approach touched
- **THEN** the briefing's `reversals` warns "Do not re-attempt … (retired as of commit Y) — recorded reason: …", rather than omitting it

#### Scenario: Reverted intent is never served as authoritative

- **GIVEN** a decision superseded by a later decision whose own status is still `approved`/`draft`/`verified` (consolidation has not yet flipped it to `rejected`)
- **WHEN** `orient` or `recall` runs for a task in that decision's scope
- **THEN** the superseded decision appears only under `reversals`, never under `pendingDecisions` / the authoritative recall set

### Requirement: FleetLevelAnchoredMemory

A memory **or decision** anchored to a published interface SHALL surface, with its freshness verdict,
when an agent recalls while editing a consumer repository that references that interface. `recall` SHALL
accept the opt-in `federation` / `federationRepos` params (inert without an `.openlore/federation.json`
registry) and, when active, return a `fleetMemory` block with `memories` and `decisions` arrays: for
each upstream interface the home repo references (its external call edges), it loads each scoped producer
repo's index once, selects the producer memories and active decisions anchored to that interface (matched
by exact symbol name — arity/overload unconfirmed at an external call site), and computes each record's
freshness against the **producer's** graph. A fleet-level record whose anchor no longer exists in the
producer SHALL be `orphaned` and withheld from the authoritative set, identically to a single-repo
record; a retired (invalidated) producer memory or an inactive (rejected/synced/phantom) producer
decision SHALL likewise be excluded. The selection SHALL be deterministic (no LLM), bounded per kind with
an explicit omission note, and SHALL name the repos consulted and skipped (a stale/unindexed producer is
reported, never guessed). Note a deliberate consequence of the `synced` exclusion across the boundary: a
producer decision that reaches its finalized `synced` state (its content folded into the producer's local
ADRs / `spec.md`) is intentionally NOT federated, because that content lives in producer-local specs a
consumer cannot read — so the decision side surfaces primarily transient `draft`/`approved`/`verified`
producer decisions, and an empty `fleetMemory.decisions` does not imply the producer recorded no
architectural constraints on the interface.

#### Scenario: A producer-side memory surfaces in a consumer

- **GIVEN** a fresh memory anchored to an interface exported by repo A, and consumer repo B references it
- **WHEN** an agent recalls in B with `federation` active
- **THEN** the memory surfaces in B's `fleetMemory` carrying its freshness verdict, naming repo A

#### Scenario: An orphaned fleet memory is withheld

- **GIVEN** a producer memory whose anchor symbol no longer exists in the producer
- **WHEN** an agent recalls in a consumer repo with `federation` active
- **THEN** the memory does not appear as authoritative, even though the producer repo was consulted

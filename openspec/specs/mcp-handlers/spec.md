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

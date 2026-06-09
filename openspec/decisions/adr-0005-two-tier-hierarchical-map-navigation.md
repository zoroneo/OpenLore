# ADR-0005: Two-tier hierarchical map navigation over communities

## Status

accepted

**Domains**: analyzer, mcp-handlers

## Context

The repo's call graph is far too large to hold in a context window (~3,582 functions / ~7,716 edges).
An agent had no coarse view: it could fetch one function's neighbourhood (`get_subgraph`) or one
community's membership (`get_cluster`), but not the map of regions and how they connect, then descend.
So orientation either over-fetched or proceeded blind, and multi-hop questions forced stitching many
`get_subgraph` calls — the context-exhausting traversal the substrate exists to prevent.

`buildClusterGraph(graph)` aggregates the EXISTING label-propagation communities
(`communityId`/`communityLabel` on `FunctionNode` — no re-clustering) into super-nodes
`{communityId, label, memberCount, fileCount, topFiles, topLandmark}` and super-edges
`{fromCommunity, toCommunity, callCount}` counting distinct cross-community calls (self-edges
excluded). `topLandmark` uses the highest-fan-in member name (the `get_cluster` naming convention)
rather than coupling to the landmark-signals change, since labels carry no single "top" without a
composite score. A `get_map` tool returns the bounded region view (top-K regions by member count with
an explicit `truncated` count, no silent capping) and no function bodies; given a `communityId` it
drills in via the shared `buildClusterView` extracted from `handleGetCluster`, so `get_cluster` and
the drill-in render a region identically.

## Decision

The system SHALL expose a two-tier map of the call graph: a region tier where each community is a
super-node with aggregated inter-region super-edges (derivable without reading any function body),
and a function tier reached by drilling into one region (reusing the community-membership view). The
region tier SHALL ship in the opt-in `navigation` preset only and be conclusion-classified.

## Consequences

`handleGetCluster` is refactored to delegate to the new exported `buildClusterView(cg, absDir,
communityId)`; behaviour is preserved (community label read from the top member, identical since all
members share it). `get_map` widens the navigation preset, so the spec-28 nav payload ceiling is
bumped as a conscious budget decision. No new clustering algorithm or threshold; it reuses
communities, call edges, and the `get_cluster` view. Deliberately two tiers (regions → functions);
recursive nesting is out of scope. A new `mcp-handlers` spec domain holds the requirement.

> Recorded by openlore decisions on 2026-06-09
> Decision ID: c683d90d

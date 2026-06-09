# ADR-0006: Goal-conditioned landmark pathfinding

## Status

accepted

**Domains**: mcp-handlers, analyzer

## Context

`trace_execution_path` already answers "how does A reach B?" but requires both endpoints named
exactly and returns up to `maxPaths` raw DFS chains. Two gaps remained for goal-conditioned
navigation: endpoints are often known by KIND ("from an entry point into this file", "to whatever DB
write it reaches"), not exact name; and planning wants the single BEST path by cost, not ten chains to
read.

`find_path` accepts `from`/`to` as exact/fuzzy names OR selectors. `resolveEndpoint` maps each
selector through an EXISTING classifier with no new threshold: `landmark:<id>` resolves a node by
id/name; `role:entrypoint` = `cg.entryPoints`; `role:hub` = `cg.hubFunctions`; `role:sink` = a called
leaf (zero outgoing internal call edges AND `fanIn >= 1` — parameter-free); `file:<path>` = functions
in that file. `findCheapestPath` runs `weightedBfs` forward from the `from` seeds and stops at the
nearest reached `to` seed, reconstructing the chain via the predecessor map. Both cost modes go
through `weightedBfs`: call-distance mode uses `buildWeightedAdjacency` (confidence weights); hop-count
mode uses unit-cost adjacency (distance == hops) so a fewest-hops path is selected when call-distance
is disabled. It returns the single cheapest path plus up to `MAX_ALTERNATES` (3) next-best paths, each
`{chain, hops, distance}`, with a stated reason.

## Decision

The system SHALL provide a `find_path` tool that resolves name/selector endpoints to concrete
functions and returns the single cheapest call path (by call-distance, else hop-count) with a bounded
set of alternates and a stated reason; "no path within budget" SHALL be a structured answer reporting
how far the search reached, not an empty array. The tool SHALL be conclusion-classified and ship in
the opt-in `navigation` preset only.

## Consequences

Extends rather than replaces `trace_execution_path` (which keeps DFS enumeration); `find_path` adds
endpoint resolution + cost-based single-path selection. `landmark:<id>` resolves by node id/name
rather than recomputing the landmark signal set, since the endpoint just needs the node. Depth and
distance are bounded by `SUBGRAPH_MAX_DEPTH_LIMIT` and a distance cap, so the tool cannot force an
unbounded traversal. Adding `find_path` to the navigation preset bumps the spec-28 nav and
full-surface payload ceilings as conscious decisions. The requirement lands in the `mcp-handlers`
spec domain.

> Recorded by openlore decisions on 2026-06-09
> Decision IDs: 539ee661, c92ac44b

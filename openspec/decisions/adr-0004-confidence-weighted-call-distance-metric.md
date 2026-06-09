# ADR-0004: Confidence-weighted call-distance metric

## Status

accepted

**Domains**: analyzer

## Context

Call edges were unweighted; context scoping used fixed per-tier neighbour counts with no notion of
structural nearness. The change introduces `callDistance(edge)`: a deterministic cost derived solely
from the edge's resolution confidence, via a named `CALL_DISTANCE_COSTS` table. Costs: strongly
resolved edges (`import`, `same_file`, `self_cls`, `http_endpoint`) = 1; moderately resolved
(`type_inference`, `type_name`) = 2; heuristic (`name_only`) = 3; `external` = Infinity (a synthetic
leaf, never traversed for internal scoping). The switch is exhaustive against `EdgeConfidence`
(compile-time `never` check) with a defensive runtime fallback of 3 for malformed/legacy data. A
`weightedBfs` (Dijkstra over the small in-memory weighted adjacency built from `calls` edges)
accumulates distance and returns `Map<nodeId,{distance,hops,predecessor}>` so callers can reconstruct
the cheapest path. `get_minimal_context` reinterprets its existing risk tiers as a distance budget +
k cap and ranks neighbours by nearest distance instead of taking arbitrary direct neighbours,
attaching `distance`/`hops` to each entry as bounded provenance.

A verification pass on the repo's own graph then showed the first budget cut (low=2/med=3/high=4)
returned ZERO callers for 17% of low-risk functions whose direct callers are `name_only` edges
(cost 3 > budget 2). Since `get_minimal_context` exists to show direct callers for safe edits, the
budget was refined to floor at the maximum direct-edge cost: low=3, med=4, high=6. Direct neighbours
are therefore always within budget and never dropped for weak resolution; the tier governs only how
far past direct a tightly-coupled chain is pulled in, and the k-cap plus distance ranking decide what
survives when neighbours are plentiful.

## Decision

The analyzer SHALL expose a deterministic `callDistance` per call edge (a pure function of resolution
confidence) and a `weightedBfs` that accumulates it; `get_minimal_context` SHALL scope neighbours by
nearest call-distance within a risk-derived distance budget that floors at the maximum direct-edge
cost, reporting each neighbour's distance and hops.

## Consequences

`get_minimal_context` surfaces tightly-coupled multi-hop chains and ranks by structural nearness while
never dropping a direct neighbour for weak resolution. Direct external callees are still surfaced so
external-dependency visibility is not regressed; recursive functions are flagged via a `recursive`
field rather than listed as their own neighbour. `http_endpoint` (absent from the proposal's draft
cost list) is assigned cost 1. The DB-streaming `weightedBfs` variant (EdgeStore) is deferred until a
consumer needs off-heap traversal; `get_minimal_context` already loads the graph in memory.

> Recorded by openlore decisions on 2026-06-09
> Decision IDs: 106b2895, 660e1edf

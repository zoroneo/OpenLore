# OpenLore Spec 16 — Architectural Decisions as First-Class Graph Nodes

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md).
> Depends on [Spec 15](openlore-spec-15-governance-dogfooding.md) (needs real decisions to project).

---

## Progress

Branch: `openlore-spec-16-decisions-as-graph-nodes`. **DONE** — [PR #111](https://github.com/clay-good/OpenLore/pull/111).

- [x] Add a decision node type and an `affects` edge kind — `DecisionNode` /
      `DecisionAffectsEdge` in [src/core/decisions/project.ts](../../src/core/decisions/project.ts);
      `'affects'` added to `EdgeKind` ([call-graph.ts:39](../../src/core/analyzer/call-graph.ts#L39)).
- [x] Project the existing decision store onto graph nodes/edges (derived, like IaC) —
      `projectDecisions(store)` mirrors `iac/project.ts`; wired into
      [`writeEdgesToSQLite`](../../src/core/analyzer/artifact-generator.ts) (load store →
      project → normalize paths → persist), best-effort so a bad store never fails the graph write.
- [x] Make `analyze_impact` / `get_subgraph` return governing decisions as neighbors —
      new `decisions` + `decision_edges` tables in
      [edge-store.ts](../../src/core/services/edge-store.ts) with `getDecisionsForFiles()`
      (the deterministic join); both handlers emit a typed `governingDecisions` field
      (`nodeType: "decision"`), kept out of the code-edge BFS so blast-radius math and hub
      stats are unchanged.
- [x] Keep `orient`'s existing decision-surfacing working; upgrade it additively —
      `pendingDecisions` is untouched; an optional graph-derived `governingDecisions` field
      (with file-level provenance) was added alongside it.
- [x] Bump `SCHEMA_VERSION` (2 → 3); confirm clean rebuild and backward compatibility —
      the bump drops + recreates all tables (rebuild-on-bump, no migration); empty/legacy/missing
      stores project to zero nodes. Tests: `src/core/decisions/project.test.ts`,
      `edge-store.test.ts` (decisions block), `graph.test.ts` (governing-decisions block),
      `src/core/analyzer/decision-projection.test.ts` (persistence wiring). Full suite green
      (2965 passing across 131 files), lint + typecheck + build clean.

> Note: this repo's *active* decision store is empty post-sync (synced decisions are purged
> to ADRs/specs and surfaced via the vector index), so projection here yields zero decision
> nodes — the documented empty-store path. The feature is exercised live whenever an agent
> records a decision during a dev session (it projects while `verified`/`approved`, until synced),
> and is covered end-to-end by fixtures.

---

## Context for you (the agent)

Today decisions are stored in a side-file and surfaced by a runtime string set-membership test
on `affectedFiles` / `affectedDomains`
([orient.ts](../../src/core/services/mcp-handlers/orient.ts#L355-L380)). That is a filter, not a
graph relationship: decisions are not nodes, not traversable, and invisible to
`analyze_impact` / `get_subgraph`.

Promoting `Decision` to a first-class graph node with `affects` edges to the function/file nodes
it governs turns the filter into the deterministic join Spec 13 calls for, and makes
"what decisions govern this code, and what does changing it implicate?" answerable by the same
impact machinery as code edges. This is the relationship no navigation competitor offers.

In the Spec 13 layering this is itself a **Layer-3 analysis instrument** (decisions made
queryable), and it is the substrate the architecture-invariant guardrails (Spec 23) build on.

The pattern already exists in the repo: the IaC subsystem projects external records onto the
existing `FunctionNode` / `CallEdge` / `ClassNode` primitives via a parser→projector split
([iac/types.ts](../../src/core/analyzer/iac/types.ts),
[iac/project.ts](../../src/core/analyzer/iac/project.ts)). Decisions follow the same shape: the
JSON store remains the authored source of truth; the graph projection is derived and regenerable.

## Scope contract — do not break these things

This PR must NOT:

- Change the decision authoring workflow (`record_decision` → consolidate → gate → sync) or its
  on-disk format. The store stays the source of truth.
- Break `orient`'s current decision output — preserve the existing field; add to it.
- Require an API key. Decisions already exist; this is pure graph wiring, fully deterministic.
- Destabilize the call-graph / edge-store hubs (highest fan-in/out in the repo). Changes are
  additive: a new edge kind and a derived projection, no rewrite of call edges.

This PR must:

- Extend `EdgeKind` ([call-graph.ts:39](../../src/core/analyzer/call-graph.ts#L39)) with an
  `affects` (or `decided_by`) kind, and represent decision nodes in the node store.
- Add a projector that maps the loaded decision store onto decision nodes + `affects` edges at
  analyze/load time (mirroring `iac/project.ts`).
- Update `analyze_impact` / `get_subgraph` and the analysis handlers to include decision
  neighbors, clearly typed so callers can distinguish them from code nodes.
- Keep `orient`'s response additive: the existing `pendingDecisions` surfacing continues to work;
  graph-derived decisions are an addition, not a replacement.
- Bump `SCHEMA_VERSION`; the edge store rebuilds from source on bump, so existing users incur one
  re-analyze and no migration.

## The deliverable

- A decision-node + `affects`-edge projection of the decision store, derived and regenerable.
- Impact/subgraph queries that return governing decisions as graph neighbors.
- Tests: a fixture decision store projects into nodes/edges; `analyze_impact(file)` returns the
  intersecting decision as a neighbor (not a post-hoc filter); legacy stores project cleanly.

## Implementation approach (where it lives)

- **Project decisions exactly like IaC.** A projector (mirroring
  [iac/project.ts](../../src/core/analyzer/iac/project.ts)) maps the loaded decision store onto
  decision nodes + `affects` edges at analyze/load time. Decisions remain authored in
  `.openlore/decisions/pending.json` (the source of truth); the graph copy is derived and
  regenerable — the IaC pattern, applied to a second data source.
- **Storage:** a new `decisions` table in
  [edge-store.ts](../../src/core/services/edge-store.ts) + a `SCHEMA_VERSION` bump (rebuild from
  source). A new `affects` `EdgeKind` ([call-graph.ts:39](../../src/core/analyzer/call-graph.ts#L39)).
- **Traversal:** `analyze_impact` / `get_subgraph` include decision neighbors via
  `buildAdjacency()`, which already merges inheritance edges the same way — typed so callers can
  tell a decision from a function.
- **`orient`:** keep the existing `pendingDecisions` set-membership output
  ([orient.ts ~362–382](../../src/core/services/mcp-handlers/orient.ts#L362)); **add** graph-derived
  decisions as an optional field.

## Compatibility verification (grounded 2026-05-30)

- **Decision file format unchanged**; the gate is unaffected (it only reads decision statuses).
- **`affects` is additive** — no code switches exhaustively on `EdgeKind`, and `calls`-only filters
  exclude it by default.
- The new `decisions` table sits behind a `SCHEMA_VERSION` bump → rebuild from source, no migration.
- `orient` / `analyze_impact` responses gain **optional** fields only (additive-by-cast).

## Edge cases & failure modes

- **Inactive decisions** (`synced` / `rejected` / `phantom`) are excluded from projection, matching
  orient's `INACTIVE_STATUSES`.
- **Empty / legacy store** → zero decision nodes; everything else is unchanged.

## Acceptance

- `analyze_impact(file)` and `get_subgraph` surface governing decisions as typed graph neighbors.
- `orient` still returns decisions (existing behavior intact).
- `SCHEMA_VERSION` bumped; a re-analyze produces the projected nodes/edges; no data loss.

## Compatibility note

The decision JSON store remains authoritative and unchanged; the graph projection is derived and
rebuilt from it. `orient`'s output is additive. The schema bump costs users a single re-analyze.

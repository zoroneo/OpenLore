# OpenLore Spec 17 — Cross-Domain Impact Analysis (Code ↔ Infrastructure)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md).

---

## Progress

Branch: `openlore-spec-17-cross-domain-impact`. **DONE** — [PR #112](https://github.com/clay-good/OpenLore/pull/112).

- [x] End-to-end traversal across the code↔infra boundary. Investigation found code
      and infra were *disconnected components* — both in the graph, but no edge linked
      them (`bfsFromDB` already traverses `references`/`depends_on`; the missing piece was
      a connecting edge). Added the deterministic link: `linkCodeToInfra` in
      [call-graph.ts](../../src/core/analyzer/call-graph.ts) attaches a `references` edge
      from the enclosing code function to each embedded IaC resource (Pulumi/CDK/CDKTF) it
      provisions, by line containment. Standalone `.tf`/`.yaml` (no co-located code) stays
      infra-only, exactly as before.
- [x] Surface through `analyze_impact` and `orient`. `analyze_impact` now partitions the
      blast radius: pure-code chains stay code, infra neighbors go in a typed,
      ecosystem-tagged `crossDomain.infrastructure` block (`nodeType: "infrastructure"`)
      with a `blastRadius.infrastructure` count; the field is omitted entirely for
      code-only impact (byte-for-byte unchanged). `orient` tags IaC neighbors in its
      callPaths with `domain: "infra"`. `get_subgraph` already returns `language`.
- [x] One published, reproducible example —
      [docs/cross-domain-impact.md](../cross-domain-impact.md) +
      fixture [iac/fixtures/cross-domain/app.ts](../../src/core/analyzer/iac/fixtures/cross-domain/app.ts).
- [x] Deterministic and offline; tests over IaC fixtures —
      [iac/cross-domain.test.ts](../../src/core/analyzer/iac/cross-domain.test.ts) (edge,
      reachability, determinism, standalone isolation) + the `analyze_impact` cross-domain
      block in [graph.test.ts](../../src/core/services/mcp-handlers/graph.test.ts).

> Bonus fix surfaced by this work: `EdgeStore.searchNodes` passed the query straight into an
> FTS5 MATCH, so any symbol containing `:` (every Pulumi address, e.g. `Bucket:logs`) was
> misparsed as a column filter and threw. Wrapped the term as an FTS5 phrase — now any IaC
> resource is searchable/impact-queryable by name. Full suite green (2973 passing / 132 files).

---

## Context for you (the agent)

OpenLore already parses seven IaC ecosystems (terraform, pulumi, kubernetes, cloudformation,
cdk, ansible, helm) and projects their resources onto the *same* `FunctionNode` / `CallEdge` /
`ClassNode` primitives as code ([iac/types.ts](../../src/core/analyzer/iac/types.ts),
[iac/project.ts](../../src/core/analyzer/iac/project.ts)). The data to cross the code↔infra
boundary is therefore already in one unified graph.

What is missing is a query that *traverses* that boundary end-to-end: route → handler → the
Terraform/K8s resource that deploys it, and the reverse — "if I change this resource, which code
paths are affected?" This is the most distinctive capability OpenLore can demonstrate: a
code-only navigation tool or a grep-based agent structurally cannot answer it. The work is
wiring and surfacing, not new parsing.

In the Spec 13 layering this is the **first cross-domain Layer-3 analysis instrument**: a
consequence *computed* over the unified graph, not a retrieval.

## Scope contract — do not break these things

This PR must NOT:

- Re-architect IaC parsing or change the shared graph primitives.
- Add a parallel "god tool" that fragments the surface — extend the existing `analyze_impact` /
  `orient` rather than inventing a competing entry point.
- Introduce any network dependency; this is offline graph traversal.

This PR must:

- Implement an end-to-end traversal across existing code↔infra edges, reusing the existing
  graph traversal (BFS/DFS) and edge store.
- Surface results through `analyze_impact` so blast radius includes infrastructure neighbors,
  clearly typed so a caller can tell code from infra, and ensure `orient` can return the
  cross-domain neighbors when relevant.
- Ship one reproducible example (a fixture or pinned OSS repo containing both code and IaC)
  tracing a code→infra blast radius, committed as documentation.

## The deliverable

- Traversal logic that crosses the code↔infra edge boundary, built on existing primitives.
- Handler updates exposing cross-domain neighbors through `analyze_impact` (and `orient` where
  relevant), with node typing so consumers can distinguish domains.
- A committed example + tests over the existing `iac/fixtures`.

## Implementation approach (where it lives)

- **The graph is already unified.** `buildProjectedIac()`
  ([iac/index.ts](../../src/core/analyzer/iac/index.ts)) merges IaC nodes (distinguished by
  `node.language` ∈ the IaC languages, id prefix `iac-external::…`) and IaC edges (`EdgeKind`
  `references` / `depends_on`) into the same call graph the analyzer builds.
- **Cross-domain traversal** = `bfsFromDB` over the existing edges, **opting `references` /
  `depends_on` into the impact walk** (they are excluded by default by the `calls`-only filter),
  partitioned/typed by `node.language` so results separate code from infrastructure.
- **Surface** through `analyze_impact` (infra neighbors become additional, typed blast-radius
  entries) and/or an `orient` capability.

## Compatibility verification (grounded 2026-05-30)

- **No schema change** — IaC already shares the graph primitives. The only change is *opting* the
  `references` / `depends_on` kinds into the impact traversal when requested; default code-only
  behavior is preserved because the existing `calls`-only filter still excludes them.
- `analyze_impact` gains typed infra neighbors as an **optional / additive** result.

## Edge cases & failure modes

- **Repos with no IaC** behave exactly as today (no infra nodes exist).
- **Strictly distinguish infra from code by `node.language`**, so existing code-only impact is
  byte-for-byte unchanged unless infrastructure is explicitly requested.

## Acceptance

- A query of the form "what infrastructure does this handler reach / what code breaks if I change
  this resource?" returns cross-domain neighbors from the unified graph.
- The published example reproduces deterministically and offline.
- Existing `analyze_impact` behavior for code-only queries is unchanged; infra neighbors are
  additive and typed.

## Compatibility note

Additive query path over data the analyzer already produces. Existing impact results are
preserved; infrastructure neighbors are additional, typed results.

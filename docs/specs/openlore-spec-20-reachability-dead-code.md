# OpenLore Spec 20 — Reachability & Dead-Code Analysis

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md). Layer-3 analysis instrument.

---

## Progress

Branch: `openlore-spec-20-reachability-dead-code`. **DONE** — [PR #115](https://github.com/clay-good/OpenLore/pull/115).

- [x] Reachability from roots over the existing graph — forward BFS over `buildAdjacency`'s
      forward map. Roots = tests + symbols imported by name + HTTP route handlers + `main`
      (NOT the analyzer's raw entry-point set, which conflates real roots with dead helpers).
      [reachability.ts](../../src/core/services/mcp-handlers/reachability.ts).
- [x] Candidate dead-code report — the unreached remainder, each with confidence + reason.
      Conservative confidence (bias to false-live): `high` only when static-lang + no caller +
      not imported by name + **module not imported anywhere**; `low` for dynamic langs or
      consumed modules. On this repo that cut high candidates ~470 → ~35.
- [x] "What becomes dead if I delete X?" — recompute reachability with X removed from seeds +
      graph, diff against baseline (`ifDeleted` param).
- [x] Cross-language (rides the tree-sitter graph; IaC/external excluded), offline, MCP-surfaced
      — new read-only `find_dead_code` tool (47 total); no schema change.
- [x] Tests over a two-language fixture (live chain, dead orphan, dead cluster, Python dynamic,
      delete-impact diff, dep-graph-absent degradation) —
      [reachability.test.ts](../../src/core/services/mcp-handlers/reachability.test.ts). Full
      suite green (3011 passing / 136 files). Doc:
      [docs/reachability-dead-code.md](../reachability-dead-code.md).

---

## Context for you (the agent)

**The instrument:** "is this function reachable from any entry point?", "what is dead?", and
"what becomes dead if I delete X?" — classic graph reachability questions the model burns tokens
guessing at and grep cannot answer (it sees text, not reach).

OpenLore is well placed: the analysis already identifies **entry points** (functions with no
internal callers — see [CODEBASE.md](../../.openlore/analysis/CODEBASE.md)) and holds a call graph
across 15+ languages. Reachability is BFS from entry points; candidate dead code is the
unreachable remainder; "what dies if I delete X" is the set reachable *only* through X.

**Prior art:** knip and ts-prune do exactly this — mark-and-sweep from entry points — but are
**TypeScript/JavaScript-only**, and ts-prune is in maintenance mode. OpenLore's contribution is
the **cross-language** version over the unified graph.

**Honest limits — frame output as *candidates*, never deletion authority.** Entry points are not
always statically visible: dynamic entry points, framework magic (routes, DI, plugin registries),
reflection, and public-API exports consumed externally all produce false "dead" positives. The
instrument must:

- treat exported/public-API symbols and detected framework entry points as roots,
- report confidence and the reason a symbol looks dead,
- and explicitly **not** auto-delete or assert certainty.

## Scope contract — do not break these things

This PR must NOT:

- Auto-delete code or present results as certain.
- Require a build, a run, or a network/API key.
- Regress entry-point detection used elsewhere.

This PR must:

- Compute reachability from declared + detected entry points (including exported/public symbols)
  over the existing graph.
- Report candidate-dead symbols with a confidence level and the reason (e.g. "no static caller;
  not exported; not a detected entry point").
- Answer "what becomes dead if I delete X?" as the set reachable only via X.
- Be cross-language, deterministic, and offline; surface through the existing MCP handler layer.

## The deliverable

- Reachability pass (BFS from roots) + the unreachable-set computation, reusing graph traversal.
- A "delete impact" query: nodes whose only path to a root runs through the target.
- MCP surfacing, additive; results typed and confidence-tagged.

## Implementation approach (where it lives)

- **Roots** = the entry points the analyzer already computes (functions with no internal caller —
  see [CODEBASE.md](../../.openlore/analysis/CODEBASE.md) and the call graph) **plus** exported /
  public-API symbols and detected framework entry points.
- **Reachability** = `bfs` / `bfsFromDB(roots, 'forward', maxDepth)`
  ([graph.ts](../../src/core/services/mcp-handlers/graph.ts)); candidate-dead = nodes not in the
  reached set. External nodes are already filtered at the DB boundary.
- **"Dead if I delete X"** = nodes whose every root-path runs through X — recompute reachability
  with X removed and diff against the baseline reached set.
- **Surface:** a new read-only handler returning `Promise<unknown>`.

## Compatibility verification (grounded 2026-05-30)

- **No schema change**; a pure read over the existing graph + entry-point data.
- Reuses `bfs` / `bfsFromDB`; external-node filtering already exists.
- New handler returns `unknown` → existing tools untouched.

## Edge cases & failure modes

- **Dynamic / framework entry points** (routes, DI, plugin registries), reflection, and
  externally-consumed exports cause false "dead" positives. Treat exported/public symbols and
  detected entry points as roots; tag confidence; **never auto-delete**.
- **Libraries / monorepos:** public-API symbols are roots even with no internal caller.
- **Weaker per-language symbol resolution** → lower confidence, stated in the output.

## Acceptance

- A fixture with known live and dead regions yields the correct candidate-dead set, with caveats
  for dynamically-reached symbols.
- "Delete X" returns the correct downstream-dead set.
- Runs offline and deterministically across at least two languages.

## Compatibility note

Pure addition: a read-only analysis over the existing graph. No schema change, no behavior change
to existing tools; results are an additive, confidence-tagged output.

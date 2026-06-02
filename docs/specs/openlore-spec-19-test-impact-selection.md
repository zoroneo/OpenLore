# OpenLore Spec 19 — Deterministic Test Impact Selection

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md). The headline Layer-3 instrument.

---

## Progress

Branch: `openlore-spec-19-test-impact-selection`. **DONE** — [PR #114](https://github.com/clay-good/OpenLore/pull/114).

- [x] Backward reachability from changed functions/files to the tests that exercise them —
      path-tracked BFS over `buildAdjacency`'s backward map (`calls` + inheritance), collecting
      `isTest` nodes, plus a `tested_by`-edge harvest for import-based associations.
      [test-impact.ts](../../src/core/services/mcp-handlers/test-impact.ts).
- [x] Input from an explicit symbol set **or** a git diff — `diffRef` reuses the drift
      subsystem's `getChangedFiles()` ([git-diff.ts](../../src/core/drift/git-diff.ts)), mapped to
      function nodes by tolerant path match.
- [x] Output: the test set + per-test reaching path + confidence, an explicit `soundness` banner
      (`posture: "over-approximate"` + caveats) and honest `coverage`
      (`testDetection: full|partial|none` — never a false-empty).
- [x] Surfaced through the MCP layer — new read-only `select_tests` tool (46 total; def +
      dispatch + annotation in [mcp.ts](../../src/cli/commands/mcp.ts)); deterministic, offline,
      no schema change (reuses existing `calls`/`tested_by` edges + `isTest`).
- [x] Tests over a fixture with known test→code reachability (paths, upstream-only selection,
      `none`-coverage honesty, no-seed message, seed resolution) —
      [test-impact.test.ts](../../src/core/services/mcp-handlers/test-impact.test.ts). Validated
      that the analyzer emits `tested_by` on real co-located source+test files. Full suite green
      (3001 passing / 135 files). Doc: [docs/test-impact-selection.md](../test-impact-selection.md).

---

## Context for you (the agent)

**The instrument:** an agent changes `parseConfig()` and asks OpenLore *"which tests should I
run?"* — and gets, deterministically, the exact set of tests that transitively reach that
function, by walking the call graph backward from the change to every test that can hit it.

This is the clearest demonstration of the Layer-3 thesis (Spec 13):

- **grep cannot do it** — the tests reach the code through indirect call paths, not text matches.
- **the model is expensive and unreliable at it** — it would have to read the whole suite and guess.
- **a deterministic graph does it instantly** — it is backward reachability over edges we already store.
- **it saves real money** — agents running full suites or guessing wrong is a major time/token sink.
- **no MCP competitor ships it.**

It is also ~80% built: the graph already has `tested_by` edges and test detection
([EdgeKind](../../src/core/analyzer/call-graph.ts#L39); test-file detection in
[call-graph.ts](../../src/core/analyzer/call-graph.ts)), plus working graph traversal in the
existing `analyze_impact`/`get_subgraph` handlers.

**Prior art (this is established CS, not novelty):** regression test selection (RTS). Dynamic RTS
(Ekstazi) collects file dependencies at runtime; static RTS (RTS++, building on Ryder & Tip's
call-graph change-impact analysis) selects tests from the call graph. OpenLore's flavor is
**static, call-graph-based RTS served to the agent at edit time** rather than to CI after the
fact — the same algorithm, a different consumer.

**Soundness — state it honestly.** Static call-graph RTS is an approximation:

- For direct/static dispatch it is a safe *over-approximation* (it may select a few extra tests —
  acceptable, the agent runs slightly more).
- Dynamic dispatch, reflection, dependency injection, and runtime wiring can cause
  *under-approximation* (a relevant test is missed). This is the classic RTS hazard.

The instrument must **prefer over-approximation, surface its confidence, and never claim it is a
sound replacement for the full suite.** It is a *prioritizer* — "run these first / these are
almost certainly the relevant ones" — not a guarantee.

## Scope contract — do not break these things

This PR must NOT:

- Change `tested_by` extraction semantics in a way that regresses existing graphs.
- Run the test suite, replace the test runner, or require a build.
- Claim soundness the analysis does not have. Document over/under-approximation explicitly.
- Add a network or API-key dependency. This is pure graph traversal, deterministic and offline.

This PR must:

- Add an MCP capability (extend `analyze_impact`, or a focused tool surfaced through the existing
  handler layer) that takes a set of changed functions/files **or** a git diff and returns the
  tests that transitively reach the change, each with the reaching path and a confidence note.
- Reuse the changed-file logic the drift subsystem already has for the git-diff input path.
- Degrade gracefully where `tested_by` coverage is sparse (some languages detect tests better than
  others) — say so in the response rather than returning a falsely-confident empty set.
- Be deterministic for a fixed graph state.

## The deliverable

- **Backward reachability**: from each changed node, BFS over call edges to reachable test nodes.
- **Inputs**: an explicit symbol/file set, or a git diff (HEAD vs working tree, or two refs).
- **Output**: the selected tests, the path that connects each test to the change, and a soundness
  banner (approximation posture + coverage caveats for the languages involved).
- **Surface**: through the existing MCP handler layer, additive to current tools.

## Implementation approach (where it lives)

- **Reuse, do not rebuild.** The backward walk is `bfsFromDB(seeds, 'backward', maxDepth, edgeStore)`
  ([graph.ts](../../src/core/services/mcp-handlers/graph.ts)) — the same primitive `analyze_impact`
  already uses for upstream chains. Seeds = the changed functions; hits = nodes with `isTest`
  ([FunctionNode](../../src/core/analyzer/call-graph.ts)) reached on the walk.
- **`tested_by` is already a first-class edge** (`EdgeKind` includes it,
  [call-graph.ts:39](../../src/core/analyzer/call-graph.ts#L39)). Use it directly and/or the
  inverse of `calls` from test nodes; decide and document which during build.
- **Changed-set input reuses the drift git layer.** `getChangedFiles()` / `resolveBaseRef()`
  ([git-diff.ts](../../src/core/drift/git-diff.ts)) turn a diff into changed files; map those to
  changed functions via the node table, then run the backward walk.
- **Inheritance is followed for free.** `buildAdjacency()` already propagates across inheritance
  edges, so overridden/parent methods widen selection (a safety win for dynamic dispatch).

## Tool contract (additive)

- **Input:** `{ dir, changedSymbols?: string[], diffRef?: string, maxDepth?: number }` (one of
  `changedSymbols` / `diffRef` required).
- **Output:** `{ changed: string[], selectedTests: [{ test, file, viaPath: string[], confidence }],
  soundness: { posture: 'over-approximate', caveats: string[] },
  coverage: { languages: string[], testDetection: 'full' | 'partial' | 'none' } }`.

## Compatibility verification (grounded 2026-05-30)

- **No schema change**: `tested_by` edges and `isTest` nodes already exist.
- **New read-only handler returning `unknown`** — existing tool responses are untouched (the
  additive-by-cast contract from Spec 13).
- Reuses `bfsFromDB`; no change to traversal primitives or to `analyze_impact`.
- Offline, deterministic, no API key.

## Edge cases & failure modes

- **Sparse `tested_by` coverage** (test detection varies by language): return
  `coverage.testDetection: 'partial' | 'none'` rather than a falsely-confident empty set.
- **Dynamic dispatch / DI / reflection** may under-select: documented in `soundness.caveats`;
  prefer widening via inheritance edges. Posture is *over-approximate* by design.
- **A test reaches code via `calls` but has no `tested_by` edge**: include via the inverse-`calls`
  path and dedupe.
- **Newly-added function with no edges yet**: fall back to file-level test association.

## Acceptance

- Changing a function in a fixture returns exactly the tests that reach it, with paths.
- The response documents when it may over- or under-select.
- Runs offline, deterministically, with no API key.

## Compatibility note

Pure addition over existing edges (`calls`, `tested_by`). No schema change required if the edges
already exist; if a new typed result field is added to `orient`/`analyze_impact`, it is additive
and optional. Existing behavior is untouched.

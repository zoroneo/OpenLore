# Tasks — Multi-repo federation

> Phase-2; build after the five memory + dispatch changes. Likely splits into sub-PRs (registry →
> resolution → query → memory). Call `record_decision` before the registry schema (data structure)
> and the cross-repo resolution contract (API contract), per `CLAUDE.md`.
>
> STATUS (2026-06-19): groups 1–3 + 5 IMPLEMENTED on `feat/multi-repo-federation`; group 4 DEFERRED
> (needs bitemporal memory, PR #163, not yet in main). Decisions `bf5aff2d`, `67ca60fe`.

## 1. Federation registry (foundation)
- [x] Define a registry manifest: per-repo `{ path|remote, fingerprint, schemaVersion, lastBuilt }`.
      → `src/core/federation/types.ts` (`FederationRepoEntry`), project-local `.openlore/federation.json`.
- [x] `openlore federation add|remove|list` (or equivalent) edits the registry; each repo builds its
      own local index independently. No global build. → `src/cli/commands/federation.ts`, `registry.ts`.
- [x] Test: adding/removing a repo updates only the registry + that repo's index.
      → `src/core/federation/registry.test.ts` (add/remove/dedupe/name-clash/home-repo-reject).

## 2. Cross-repo symbol resolution (reuse stable IDs)
- [x] Resolve a published symbol's consumers across indexed repos via content-addressed stable IDs /
      SCIP monikers. Exact-match only; no guessing. → `resolver.ts` `findCrossRepoConsumers(Batch)`,
      `EdgeStore.getExternalConsumers`. Match is on the stable-ID *name descriptor* against consumer
      external call targets (call sites carry no signature) — disclosed in `caveats`.
- [x] Report unindexed/stale repos explicitly (hand off to `add-confidence-boundary-disclosure`).
      → `repoStatus` / `evaluateRepoState`; every conclusion carries `reposConsulted` / `reposSkipped`.
- [x] Test: a symbol exported by repo A resolves to its callers in indexed repo B and reports repo C
      (unindexed) as not-consulted. → `resolver.test.ts` (consumer resolution + stale-skip).

## 3. Federation-scoped queries (lazy + budgeted)
- [x] Add an optional federation scope to `analyze_impact`, `find_path`, `find_dead_code`,
      `select_tests`; load per-repo indexes on demand; respect a token budget; name repos consulted.
      → `graph.ts`, `pathfind.ts`, `reachability.ts`, `test-impact.ts`; lazy `readCachedContext`;
      `DEFAULT_MAX_CONSUMERS` cap; coverage named in every response.
- [x] Test: cross-repo dead-code on a shared export is correct and bounded; result lists repos seen.
      → `resolver.test.ts` + e2e dogfood (`DOGFOOD-federation.md`): `find_dead_code` keeps a producer
      symbol alive via a consumer; `analyze_impact` names the consumer; `select_tests` selects the
      consumer's test; `find_path` locates the producer + bridge.

## 4. Fleet-level memory and decisions  — DEFERRED (needs bitemporal memory, PR #163)
- [ ] Allow a memory/decision to anchor to a published interface via stable ID; surface it in consumer
      repos. Reuse bitemporal + freshness machinery.
- [ ] Test: a memory anchored to an upstream interface surfaces (with verdict) when recalling in a
      consumer repo.

> **ARCHIVE NOTE.** The `FleetLevelAnchoredMemory` requirement in
> `specs/mcp-handlers/spec.md` covers this deferred group. It is marked DEFERRED there
> and MUST NOT be promoted into the live `openspec/specs/mcp-handlers/spec.md` when this
> change is archived — doing so would make `audit_spec_coverage` flag a phantom
> unimplemented requirement. Re-home it into its own change once PR #163 (bitemporal
> typed memory) lands in `main`.

## 5. Surface + docs
- [x] Register federation capability behind an opt-in `federation` preset; nothing in the default.
      → `TOOL_PRESETS.federation` + `federation_status` (preset-only); `mcp-presets.test.ts` guards it.
- [x] Document the index-of-indexes model and local-first posture in `architecture` + `CODEBASE.md`.
      → this proposal + `DOGFOOD-federation.md`; spec deltas in `specs/`.

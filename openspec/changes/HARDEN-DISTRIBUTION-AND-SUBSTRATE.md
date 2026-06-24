# Change set: distribution surface + substrate correctness + first-run friction

> Status: PROPOSED (2026-06-22). Three independent change proposals. Each is shippable on its own;
> there is no dependency edge between them. They are grouped only because they answer one question —
> *what stops OpenLore's unique value from reaching a human or staying trustworthy once it does?*

Three gaps, three proposals:

| # | Change | Primary domain | One-line | Status |
|---|--------|----------------|----------|--------|
| 1 | `add-pr-review-surface` | cli | Post `structural_diff` + `blast_radius` + drift as a deterministic, sticky PR comment — value into a daily human workflow, no agent required. | SHIPPED |
| 2 | `fix-transitive-incremental-staleness` | analyzer | Make incremental watch updates converge to the full-analyze graph, or *explicitly* flag the un-converged region stale. Fix the substrate, not just the warning. | SHIPPED (PR #189) |
| 3 | `make-embeddings-zero-config` | config / cli | Commit to BM25 as an honest first-class default (no "degraded fallback" framing) *and* offer a zero-config local embedder as a true one-command opt-in. Remove embeddings from the happy path. | SHIPPED (`feat/make-embeddings-zero-config`) |

## The shared thread

OpenLore's north star (`overview/spec.md`, decision `c6d1ad07`) is *deterministic, locally-computed
structural context as a substrate for coding agents*. Each of these three closes a gap between that
promise and what a real user experiences:

1. **Distribution.** The MCP path only fires when an agent chooses to call a tool. Everyone opens
   PRs. The unique deterministic value — "this removed `gamma`, changed `alpha`'s signature, 5
   callers are now stale, run these 3 tests, ADR-12 governs this" — belongs in the highest-visibility
   human workflow there is. This is likely OpenLore's best distribution channel and it needs no agent.

2. **Correctness.** The load-bearing feature is "you are told when a fact is stale." Today the
   incremental watcher is depth-1 only (`README.md:593`): `A→B→C`, `C` changes, `A` stays silently
   wrong until the next `analyze --force`. The Epistemic Lease decays the *warning* but the *graph
   itself* is incorrect. A trust-eroding correctness gap in the substrate must be fixed at the
   substrate.

3. **Friction.** Embeddings are unavailable even in OpenLore's own repo (`orient` falls back to BM25).
   There is literally a `first-run-hardening` skill — a standing signal that users churn at install.
   Either make the semantic upgrade frictionless or commit honestly to BM25 and stop framing it as a
   fallback. Both, ideally.

## Constraints honored across the whole set

- **No LLM on any hot path.** Every analysis composed here is already deterministic and local.
- **Determinism is a hard constraint.** No learned/statistical ranking is load-bearing; the local
  embedder in proposal 3 is an optional ranking aid, never a correctness dependency.
- **Tool-surface discipline.** No new MCP tool is added by any of the three. Proposal 1 is a CLI +
  CI surface; proposal 2 hardens an existing path; proposal 3 is config + CLI. The lean default
  MCP surface (`add-lean-default-tool-surface`, PR #185) stays constant in size.
- **Conclusion-shaped output.** The PR comment is a briefing (named risks + counts + commands),
  never a graph dump.
- **No new always-on blocking gate.** Proposal 1's CI comment is advisory by default, mirroring the
  `blast_radius` hook's opt-in-blocking posture.

At implementation time, call `record_decision` before writing code for any proposal that introduces
a new command, data format, config field, or bundled artifact (per project `CLAUDE.md`).

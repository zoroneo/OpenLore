# Spec-store integration — deterministic structural context for externally-stored, multi-repo plans

> Status: COMPLETE (2026-06-21). Umbrella overview for three dependency-ordered, independently
> shippable changes — all three now shipped (change 1 PR #178, change 2 PR #180, change 3 on
> `feat/change-impact-certificate`). Each change shipped its own spec deltas into the canonical specs tree.

## The shape of the integration

OpenLore is increasingly invoked not as a standalone CLI a human runs, but as a deterministic
structural-context engine that an external planning system calls. That external system tends to keep
**specs and changes in their own repository, separate from code**, and to link a single plan to one or
more **target code repositories** it is about (plus **reference repositories** it draws context from).
The plan repository is registered by name on a developer's machine; the code repositories are ordinary
local checkouts.

Today OpenLore indexes one repository in isolation. It has no notion that a plan living *outside* the
code repo is the thing driving the edit, nor that a single change may span several target repos. The
external system, for its part, can *declare* these relationships but cannot make them true: it knows the
plan targets repo X, but it cannot say what a change to satisfy the plan would actually touch in X, what
it would newly reach, which specs would drift, or which tests must run. Those are exactly the questions
OpenLore already answers deterministically, for a single repo, with `orient`, `blast_radius`,
`analyze_impact`, `check_spec_drift`, and `select_tests`.

This initiative closes that gap. It teaches OpenLore to (1) **bind** to an external spec store and its
declared targets, (2) **assemble** deterministic working-set context for an active change across those
targets, and (3) **certify** the structural impact of a proposed change as a decaying, checkable
artifact. Every capability is additive, deterministic, and grounded in the graph OpenLore already
builds. The north star (`c6d1ad07`) holds: no LLM enters the path; these changes orchestrate and extend
existing static analysis.

## The three changes

| Order | Change | What it adds | Builds on |
|-------|--------|--------------|-----------|
| 1 ✅ | `add-spec-store-binding` | **SHIPPED (2026-06-21).** Bind OpenLore to an external spec repository that declares target + reference code repositories; resolve names to local indexes; health-check the binding. | `add-multi-repo-federation` |
| 2 ✅ | `add-working-set-context-briefing` | **SHIPPED (2026-06-21).** For an active change, assemble a deterministic, token-budgeted structural briefing across its targets — the working-set context an agent needs before editing. | `add-spec-store-binding`, `orient`, `add-trust-calibrated-context-economy` |
| 3 ✅ | `add-change-impact-certificate` | **SHIPPED (2026-06-21).** For a proposed change, emit a decaying, conclusion-shaped impact certificate: blast radius, newly-opened paths to declared covering surfaces, drifted specs, tests to run. | `add-working-set-context-briefing`, `blast_radius`, `add-code-anchored-memory-staleness` |

Each is shippable alone and earns its keep alone. Together they let an external, multi-repo planning
workflow stand on deterministic structural ground instead of declarations.

## Design invariants (shared by all three)

- **Deterministic, no LLM.** Every output is computed from the call graph, reachability, spec drift,
  and test-selection that OpenLore already produces. The north star (`c6d1ad07`) is not relaxed.
- **Conclusion-shaped, never a graph.** Outputs are briefings and certificates an agent acts on
  directly — counts, named risks, named paths — classified `conclusion` in `tool-contract.ts`.
- **A stable machine contract.** Every new tool and command emits documented `--json` with stable
  finding/diagnostic codes, so an external orchestrator can consume results without scraping prose.
- **Lean and opt-in.** Nothing here enters the `minimal` / first-run default tool surface. These are
  opt-in capabilities for repositories that participate in an external spec-store workflow.
- **Declarations are inputs, not authority.** OpenLore reads the external store's declared
  targets/references/surfaces; it never clones, mutates, or fences them. It only reports.
- **Certify, don't assert.** Where OpenLore states an impact conclusion to a human or an orchestrator,
  it emits a checkable artifact with a freshness lease — not a bare claim. When the change or the graph
  moves, the artifact goes stale and the health check re-fires it.

## Research basis

Static change-impact analysis and regression test selection (Legunsen et al., STARTS, FSE 2016) at the
plan boundary; reachability/points-to analysis used differentially to detect *newly-introduced* paths
rather than existing callers; covering-surface monitoring from policy-as-code (declare a semantic or
governance boundary, watch whether a change crosses it) rather than file-glob ownership; and the shift
in continuous-compliance practice from point-in-time review to a continuously re-validated artifact,
realized here through OpenLore's existing code-anchored freshness lease.

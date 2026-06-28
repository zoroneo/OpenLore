# ADR-0022: Lean default MCP surface = navigation preset; full 62-tool surface is opt-in via --preset full / --all-tools

## Status

superseded by ADR-0023 (decision c79ec7ca, 2026-06-28)

> The default MCP surface is now the `substrate` preset (the navigation core plus `recall` +
> `verify_claim` + `blast_radius`), after the DefaultSurfaceRevealsAllFaces benchmark cleared the flip
> across two models and both repo tiers with no regression. `--preset navigation` remains a one-flag
> reversible escape. This ADR is retained as the historical record of the prior lean-navigation default.

**Domains**: analyzer, drift, cli

## Context

OpenLore exposed all 62 MCP tools by default (selectActiveTools with no selector returned allTools; install wired `openlore mcp` with no preset), contradicting both the Spec 14 agent-benchmark result (the net win comes specifically from `--preset navigation`, a ~10-tool graph-traversal surface) and the mcp-quality MinimizeToolSurface rule (schemas for uncalled tools are pure per-request overhead and degrade tool-selection accuracy). Invert the default: no selector now resolves to the lean default = the existing `navigation` preset verbatim (orient, search_code, get_subgraph, trace_execution_path, analyze_impact, suggest_insertion_points, get_function_skeleton, get_landmarks, get_map, find_path). The full TOOL_DEFINITIONS surface stays reachable via `--preset full` (alias `all`) or `--all-tools`. Governance/memory/verify/federation remain opt-in named presets, unchanged. Shared default/full preset names live in src/constants.ts so install adapters need not import the heavy MCP module.

## Decision

The system SHALL expose the navigation preset as the default MCP tool surface and require an explicit selector (--preset full or --all-tools) to activate the complete tool registry.

## Consequences

No tool is removed; --preset full restores prior behavior exactly. The default-installed surface no longer includes governance tools (record_decision, check_spec_drift, detect_changes) — agents relying on the decisions pre-commit-gate workflow should install with --preset full or governance preset; documented with a migration note. The tool-count doc guard asserts the documented default count against the lean preset and the full count against TOOL_DEFINITIONS.length. New tools added to the registry default to opt-in (absent from the lean default) unless an evidence-backed decision adds them.

> Recorded by openlore decisions on 2026-06-22
> Decision ID: a6c916ed

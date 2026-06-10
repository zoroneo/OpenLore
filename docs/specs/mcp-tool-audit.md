# MCP Tool Surface Audit (Spec 11)

> **Status (verified 2026-06-09): COMPLETE (reference).** This is the M1 audit deliverable for
> [spec-11](openlore-spec-11-mcp-tool-surface-audit.md); its conclusion (surface is coherent, no
> renames/merges; annotations + descriptions in place) is implemented. Reference doc, not pending work.

> Audit of all 49 MCP tools: purpose, overlap, and a keep / merge / rename recommendation.
> Conclusion up front: **the surface is coherent — no renames or merges are required.** Names
> follow a consistent `verb_noun` / `get_<noun>` convention; overlaps are intentional
> scope/granularity variants. Every tool now carries complete MCP `annotations`
> (`title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`), and
> descriptions follow the WHEN-to-use / WHEN-NOT pattern.

## Conventions (M2 — naming)

- **Read accessors** are `get_<noun>` (`get_subgraph`, `get_spec`). **Verbs** are bare for the
  marquee actions (`orient`, `search_code`, `analyze_impact`, `select_tests`, `find_dead_code`,
  `structural_diff`, `record_decision`). No tool deviates → **no rename / alias map needed** (M2/M5).
- **Annotations (M3)** are generated uniformly: `readOnlyHint`/`destructiveHint`/`idempotentHint`
  from a per-tool table, `title` derived from the name, `openWorldHint = true` only for the three
  LLM-backed tools (`generate_tests`, `generate_change_proposal`, `annotate_story`).

## Tools by family

### Orientation & lifecycle
| Tool | RW | Purpose | Overlap / note |
|------|----|---------|----------------|
| `orient` | RO | The entry point: functions, callers, specs, insertion points, governing decisions, provenance, change-coupling in one call | Superset starting point; everything else drills in |
| `analyze_codebase` | RWI | Run/refresh the full static analysis | Prerequisite for all read tools |
| `get_architecture_overview` | RO | Clusters, cross-cluster deps, hubs, entry points | High-level; pairs with `get_call_graph` |
| `get_call_graph` | RO | Call-graph summary stats | Lower-level than the overview |
| `get_mapping` | RO | Requirement→function mapping | Spec-coverage view |

### Graph navigation & impact
| Tool | RW | Purpose | Overlap / note |
|------|----|---------|----------------|
| `get_subgraph` | RO | Depth-limited neighborhood around a symbol | Neighborhood; `analyze_impact` adds risk |
| `analyze_impact` | RO | Blast radius + risk score + governing decisions + cross-domain infra | Decision (16) + cross-domain (17) layered in |
| `trace_execution_path` | RO | All call paths between two functions | Targeted A→B; subgraph is undirected-ish |
| `get_minimal_context` | RO | Tight per-function context (sig+body+callers+callees+tests) | Smallest; `analyze_impact` is broader |
| `get_cluster` | RO | The community a function belongs to | Community-level grouping |
| `get_file_dependencies` | RO | File-level import edges | File granularity vs function |

### Layer-3 instruments (Specs 16–22)
| Tool | RW | Purpose | Overlap / note |
|------|----|---------|----------------|
| `select_tests` | RO | Tests that transitively reach a change (RTS) | Spec 19; complements `detect_changes` |
| `find_dead_code` | RO | Reachability / dead-code candidates; "what dies if I delete X" | Spec 20 |
| `structural_diff` | RO | Graph diff between two states: added/removed/sig-change + stale callers | Spec 21; complements `detect_changes` |
| `get_change_coupling` | RO | Co-change coupling + volatility from git history | Spec 22; orthogonal (history, not code) |
| `detect_changes` | RO | Risk-rank changed functions (git diff) | Risk-ranking; `structural_diff` is the structural delta |

### Refactor & risk
| Tool | RW | Purpose |
|------|----|---------|
| `get_refactor_report` · `get_low_risk_refactor_candidates` · `get_leaf_functions` · `get_critical_hubs` · `get_god_functions` · `get_duplicate_report` | RO | Refactor prioritization from different structural angles (priority list, safe candidates, leaves, hubs, god-functions, clones). Distinct lenses — kept separate. |

### Code reading
| Tool | RW | Purpose |
|------|----|---------|
| `get_signatures` · `get_function_skeleton` · `get_function_body` · `suggest_insertion_points` | RO | Read code at increasing fidelity (signatures → skeleton → full body) + where to insert. Granularity ladder; kept. |

### Search & specs
| Tool | RW | Purpose | Overlap / note |
|------|----|---------|----------------|
| `search_code` | RO | Semantic/BM25 search over code | code scope |
| `search_specs` | RO | Search over spec text | spec scope |
| `search_unified` | RO | Merged code+spec search | convenience merge of the two — **kept** (different default scope) |
| `list_spec_domains` · `get_spec` | RO | Enumerate / read spec domains | reference |

### Inventories (derived artifacts)
| Tool | RW | Purpose |
|------|----|---------|
| `get_route_inventory` · `get_middleware_inventory` · `get_schema_inventory` · `get_ui_components` · `get_env_vars` · `get_external_packages` | RO | Per-concern inventories extracted at analyze time. One per concern; kept. |

### Spec drift, coverage, tests
| Tool | RW | Purpose |
|------|----|---------|
| `check_spec_drift` | RO | Code↔spec drift (no LLM) |
| `audit_spec_coverage` | RO | Spec coverage gaps |
| `get_test_coverage` | RO | Spec-test coverage |
| `generate_tests` | RW · open-world | LLM-generate spec tests |

### Decisions governance
| Tool | RW | Purpose | Overlap / note |
|------|----|---------|----------------|
| `record_decision` | RW | Record an architectural decision (in-session store) | writes the store |
| `list_decisions` | RO | List in-session decision store | **in-session** source |
| `get_decisions` | RO | Read synced ADRs from `openspec/decisions/` | **on-disk ADR** source — different source, **kept** |
| `approve_decision` · `reject_decision` · `sync_decisions` | RWI | Review + sync the decision workflow | gate workflow |

### Change workflow (LLM)
| Tool | RW | Purpose |
|------|----|---------|
| `generate_change_proposal` · `annotate_story` | RW · open-world | LLM-backed change proposal / story annotation |

## Decisions (M5)

- **Keep all 49.** Each tool has a distinct purpose; apparent overlaps are deliberate variants:
  - `search_code` / `search_specs` / `search_unified` — different default scopes.
  - `list_decisions` (session store) vs `get_decisions` (synced ADRs) — different sources.
  - `get_minimal_context` / `get_subgraph` / `analyze_impact` — increasing breadth.
  - `detect_changes` / `structural_diff` / `select_tests` — risk-rank vs structural-delta vs test-set.
- **No renames** → no alias map / deprecation markers required (M2).
- **Annotations complete** for all tools (M3); **descriptions** follow WHEN-to-use best practice (M4).
- **Docs synced (M6):** [docs/mcp-tools.md](../mcp-tools.md) and the project `CLAUDE.md` tool table
  reflect the current 49-tool surface.

A lean subset for low-overhead navigation is exposed via `--preset navigation` (Spec 14); the full
surface stays available by default.

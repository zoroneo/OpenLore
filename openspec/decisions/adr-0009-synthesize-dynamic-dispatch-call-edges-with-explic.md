# ADR-0009: Synthesize dynamic-dispatch call edges with explicit provenance

## Status

accepted

**Domains**: analyzer

## Context

The call graph is built purely by direct name resolution, so it is blind to dynamic dispatch (event emit/on, route→handler, callback registration), causing find_dead_code false positives, under-counted analyze_impact, and missed select_tests. A post-resolution synthesis pass recovers these edges deterministically from the AST using pattern-matching over tree-sitter trees (no LLM). Each synthesized edge carries its own provenance (confidence='synthesized' + synthesizedBy naming the rule) so it is never silently mixed with directly-resolved edges.

## Decision

The system SHALL synthesize dynamic-dispatch call edges (event channels, route handlers) deterministically from the AST and tag each with explicit provenance so they are distinguishable from directly-resolved edges.

## Consequences

EdgeConfidence gains 'synthesized'; CallEdge gains optional synthesizedBy; CALL_DISTANCE_COSTS assigns higher cost to synthesized edges so directly-resolved paths are preferred. Synthesis pass runs after resolution with per-rule fan-out caps. Reachability/dead-code must not report synthesized-only-reachable symbols as high-confidence dead; traversal tools gain a directly-resolved-only strict mode. Serialized graphs without synthesizedBy load unchanged (backward compatible).

> Recorded by openlore decisions on 2026-06-16
> Decision ID: b7395127

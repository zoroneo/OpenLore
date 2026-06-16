# ADR-0008: Anchor persisted memory to call-graph symbols with deterministic freshness

## Status

accepted

**Domains**: mcp-handlers, analyzer

## Context

Every persisted memory (architectural decisions and remember-notes) carries StructuralAnchors resolved against the call graph, and recall computes a fresh/drifted/orphaned verdict from booleans only (symbol existence + content-hash equality) — no LLM, no threshold, no weighted score. This is what code-anchored memory can do that probabilistic vector memory cannot: self-invalidate when the code it describes changes or dies, so recall never serves stale context silently.

## Decision

The system SHALL anchor persisted memories to call-graph symbols and compute deterministic fresh/drifted/orphaned verdicts on recall without LLM inference.

## Consequences

New StructuralAnchor/MemoryFreshness/AnchoredMemory types and a pure anchor engine (decisions/anchor.ts) plus a disk adapter. record_decision now captures anchors. Two new opt-in MCP tools (remember/recall) in a 'memory' preset, kept out of the default/minimal surface. recall enforces a no-silent-stale guarantee (orphaned memories are never authoritative). Notes stored in .openlore/memory, isolated from the decisions gate. Wiring memory-staleness into check_spec_drift and orient is deferred.

> Recorded by openlore decisions on 2026-06-16
> Decision ID: 34b178df

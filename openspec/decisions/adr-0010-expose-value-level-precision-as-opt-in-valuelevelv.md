# ADR-0010: Expose value-level precision as opt-in valueLevel/valueParam flags on existing impact tools

## Status

accepted

**Domains**: analyzer

## Context

The reaching-definitions overlay enables value/parameter-granularity impact analysis, but the default function-granularity answer must stay byte-for-byte unchanged (spec ValueLevelImpactOptIn). Rather than adding new tools (violating mcp-quality minimize-surface), two opt-in params — valueLevel (boolean) and valueParam (string) — are added to analyze_impact and trace_execution_path, mirroring the established directResolvedOnly opt-in pattern. With the flags absent the traversal is identical to before; with them set, the consumer loads the seed function's overlay via EdgeStore.getCfg, computes a forward data-flow slice (valueReachableLines) over def-use edges, and restricts downstream/first-hop to calls whose argument lines are data-dependent on the targeted value. Cross-call hops are labeled 'may'. When a function has no overlay (unsupported language / no CFG) the tool falls back to function granularity rather than erroring.

## Decision

The system SHALL expose value-level precision in analyze_impact and trace_execution_path via opt-in valueLevel and valueParam parameters, falling back to function granularity when no CFG overlay exists.

## Consequences

analyze_impact gains two params (valueLevel, valueParam); trace_execution_path gains two params. tools/list payload grows by two opt-in props per tool — navigation preset token ceiling bumped 11800→12300 (conscious, per spec-28 precedent). No default output changes. valueReachableLines is a pure exported overlay function in cfg.ts.

> Recorded by openlore decisions on 2026-06-16
> Decision ID: 4cf203d7

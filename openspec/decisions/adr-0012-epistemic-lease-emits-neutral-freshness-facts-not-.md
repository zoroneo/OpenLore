# ADR-0012: Epistemic lease emits neutral freshness facts, not coercive imperatives

## Status

accepted

**Domains**: mcp-handlers, analyzer

## Context

The epistemic-lease feature injected escalating imperative language into every MCP tool response (STOP, "Repository model: EXPIRED", "do NOT…"). This is structurally a prompt-injection pattern — it trains agents to obey authoritative imperatives in tool output, the exact behavior agents must resist — and contradicts the north-star decision (c6d1ad07: deterministic structural facts, not guessing) and the landmark-salience principle (hand the agent facts, let it rank). Wall-clock age alone escalated to CRITICAL (false positive), and the agent's own commits flipped the lease to stale via git-hash divergence even though committing is the most-informed action in a session. Fix: emit a single neutral, factual freshness note (minutes since orient, cognitive load since orient, whether the analysis index is behind HEAD) phrased as information the agent can act on, not a command. Drive severity from accumulated cognitive load, not wall clock.

## Decision

The system SHALL surface epistemic-lease freshness as neutral factual signals (elapsed time, cognitive load, index-behind-HEAD) rather than imperative commands directed at the consuming agent.

## Consequences

staleBlock/degradedSignal reworded to neutral facts (no STOP/EXPIRED/do-NOT, no system-banner box art); git-hash divergence no longer forces stale — it sets a factual index-behind-HEAD flag and at most contributes to degraded; computeStaleDepth driven by cognitive load, not wall-clock age; decay tracking, cross-module density/oscillation model, and telemetry retained; epistemic-lease gains a spec requirement (mcp-handlers) and ADR where it previously had neither.

> Recorded by openlore decisions on 2026-06-16
> Decision ID: 8e95746d

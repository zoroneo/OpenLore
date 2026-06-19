# ADR-0017: ReversalAwareness — orient surfaces reverted/superseded intent as do-not-repeat warnings

## Status

accepted

**Domains**: mcp-handlers

## Context

`orient`'s intent briefing already surfaces in-scope active decisions, `remember` notes, and
contradictions, each with a freshness verdict (the ProactiveIntentBriefing requirement, shipped).
But it deliberately *drops* history that was reverted: `INACTIVE_STATUSES` decisions are filtered
out (`orient.ts:430`) and invalidated memories are skipped (`orient.ts:475`). The absence of a
do-not-repeat signal is exactly what lets a fresh agent re-introduce an approach that a prior agent
or human already tried and deliberately removed — a distinct, high-cost mistake class
(`add-cross-agent-intent-handoff`, ReversalAwareness requirement). The data needed already exists:
the bitemporal supersession record on memories (`invalidatedAt`, `invalidatedByCommit`, `supersedes`)
and the `supersedes` link between decisions.

## Decision

`orient` SHALL emit an additive `reversals` field that, for the symbols and files in a task's scope,
surfaces reverted/superseded intent as pre-rendered do-not-repeat warnings — naming the commit the
note was retired as of (from a memory's `invalidatedByCommit` = HEAD when superseded, not a verified
reverting diff) and the recorded reason (the superseding item's content/rationale) — reading the
existing supersession records with no LLM. A reverted **memory** is one with `invalidatedAt` set whose
anchors fall in scope; a reverted **decision** is one targeted by another, non-`rejected`/`phantom`
decision's `supersedes` (and is excluded from the authoritative set by that same predicate, so it is
never both warned-against and served as current). The field is bounded (capped with an omission note) and omitted
when empty, so a caller that ignores it sees today's output unchanged. Reverted items are NEVER
re-surfaced as authoritative current intent — only as cautionary do-not-repeat history.

## Consequences

`orient` reads the full memory store (including invalidated memories) and resolves supersedes
back-links; both are local, deterministic reads of records already persisted. The
`add-cross-agent-intent-handoff` proposal is re-scoped: its ProactiveIntentBriefing requirement was
already shipped, so only ReversalAwareness is net-new here. Decision-side reversals carry no commit
SHA (the decision record has none); the commit is surfaced only for the memory path, where
`invalidatedByCommit` is recorded.

> Recorded by openlore decisions on 2026-06-19
> Decision ID: re17a0ce

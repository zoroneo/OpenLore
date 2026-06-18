# Tasks — Neutralize the epistemic-lease signals

> Status: IMPLEMENTED. Decision `8e95746d` recorded. Full suite green; signal dogfooded via the
> compiled module.

## 1. Neutral signal text
- [x] Rewrite `staleBlock` / `degradedSignal` to a single neutral, factual note (age, load/modules,
      repo-moved fact, `orient()` suggestion, "Informational signal" close). Drop the box-art header
      and all `STOP`/`EXPIRED`/`do NOT`/capability-invalidation rhetoric. → verified by the
      "signal is neutral and factual — no coercive language" test (scans every state/depth variant
      for banned strings).

## 2. Fix false-positive triggers
- [x] Git-hash divergence sets a factual `repoMovedSinceOrient` flag (surfaced in the note) and nudges
      `fresh → degraded`; it never forces stale/critical. → verified ("flags repo-moved and degrades
      (never forces stale)", "git divergence alone never forces stale or a stale depth").
- [x] `computeStaleDepth` is driven by cognitive load only, not wall-clock age; removed the D2/D3 age
      thresholds. → verified (depth-at-transition tests by load; "does NOT escalate depth via elapsed
      time when already stale"; "escalates to depth 3 on a post-stale burst").

## 3. Spec + decision
- [x] `record_decision` `8e95746d` (cross-domain). The feature had neither a spec nor a decision before
      this change; both are now added (mcp-handlers requirement + ADR via sync).

## 4. Regression & dogfood
- [x] `npx vitest run src examples` green (178 files, 3673 passed / 2 skipped); typecheck + lint clean.
- [x] Dogfooded the rendered output from the compiled module across fresh/degraded/stale-1/stale-3
      (with and without repo-moved): neutral, factual, no coercion; fresh emits nothing.

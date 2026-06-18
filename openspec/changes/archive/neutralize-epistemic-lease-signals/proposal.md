# Neutralize the epistemic-lease signals (facts, not coercion)

> Status: IMPLEMENTED — decision `8e95746d`. The epistemic-lease feature previously had no spec
> and no recorded decision; this change adds both and reworks the behavior.

## One sentence

Turn the per-response epistemic-lease signal from an **escalating, coercive capability-invalidation
banner** ("STOP", "Repository model: EXPIRED", "do NOT…") into a **neutral, factual freshness note**,
and stop two false-positive triggers (the agent's own commits, and pure wall-clock age) from
declaring the agent's model expired.

## Why

The epistemic lease injects a freshness signal into every MCP tool response so an agent that has
drifted into cached reasoning re-runs `orient()`. The *intent* is good. The *implementation* had three
problems, found by dogfooding it during an unrelated session:

1. **It is structurally a prompt-injection.** The signal escalated through three depths of imperative
   rhetoric explicitly engineered to be "hardest to skim past" — `STOP. Call orient()`, `Repository
   model: EXPIRED — do not use for architectural decisions`, framed in a box that mimics an
   authoritative system banner. A tool that injects authoritative commands into its own output trains
   agents to **obey injected imperatives in tool results** — the exact pattern agents must resist. It
   also contradicts OpenLore's north star (decision `c6d1ad07`: deterministic facts, "static analysis
   not guessing") and the landmark-salience decision ("hand the agent the facts and let it rank… no
   black box the agent must trust"). The lease was the opposite: a non-deterministic psychological
   nudge dressed as a system fact.

2. **The agent's own commits flipped it to stale.** Git-hash divergence from the orient baseline was
   an *immediate-stale* trigger. So an agent committing its own well-understood work — the most
   informed action in a session — was instantly told its repository model had expired.

3. **Pure wall-clock age escalated to CRITICAL.** `staleDepth` was driven partly by elapsed minutes,
   so an idle-but-well-oriented session hit depth-3 "CRITICAL" with a cognitive-load score of `2`.
   Time does not measure whether understanding is stale.

## What changes

- **Neutral, factual note.** One line of facts the agent can act on — minutes since `orient()`,
  cognitive-load score / modules touched, whether the repo has moved since `orient()` — phrased as
  information, ending "Informational signal; you decide whether to act on it." No box art, no
  `STOP`/`EXPIRED`/`do NOT`, no escalating rhetoric. `orient()` is offered as a suggestion.
- **Git divergence is a fact, not an expiry.** Repo-moved-since-orient sets a `repoMovedSinceOrient`
  flag surfaced in the note and nudges `fresh → degraded` at most; it never forces stale/critical.
- **Severity is load-driven, not clock-driven.** `staleDepth` is computed from accumulated cognitive
  load only (depth 1: load ≥ 60, depth 2: ≥ 85, depth 3: ≥ 110). Wall-clock age still moves
  `fresh → degraded → stale` (a mild note), but minutes never escalate severity to CRITICAL.

## What does NOT change

- The decay model itself (time/load/cross-module-density/oscillation tracking) and its telemetry are
  retained. The lease still fires `fresh → degraded → stale`; it is the *message* and the two
  false-positive triggers that change.
- Injection mechanics are unchanged: a separate content item, never concatenated into the result body;
  fresh = no injection.

## Out of scope

- Removing the lease or making it opt-in (considered and rejected in favor of fixing it in place).
- Re-tuning the load/density thresholds beyond removing the age-driven depth.

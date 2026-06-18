# mcp-handlers spec delta

## ADDED Requirements

### Requirement: EpistemicLeaseEmitsNeutralFreshnessFacts

The epistemic-lease freshness signal injected into MCP tool responses SHALL be a neutral, factual note
that the agent can act on, NOT a coercive or imperative instruction. It SHALL NOT inject authoritative
commands (such as "STOP"), capability-invalidation claims (such as "Repository model: EXPIRED" or "do
not use for architectural decisions"), or system-banner styling that mimics an authoritative message.
It SHALL state facts — time since the last `orient()`, the cognitive-load score or modules touched, and
whether the repository has moved since the last `orient()` — and offer re-orientation as a suggestion.
Re-running `orient()` SHALL remain the agent's decision.

#### Scenario: Freshness signal is informational, not coercive

- **GIVEN** any degraded or stale lease state at any severity depth
- **WHEN** the freshness signal is rendered into a tool response
- **THEN** it contains the factual freshness note and an `orient()` suggestion, and it contains none of
  the coercive markers ("STOP", "EXPIRED", "do not use", "NOT AUTHORITATIVE", or banner box-drawing
  characters)

#### Scenario: Fresh state injects nothing

- **GIVEN** a fresh lease state
- **WHEN** a tool response is produced
- **THEN** no freshness signal is injected and the response is unchanged

### Requirement: EpistemicLeaseTriggersReflectUnderstandingNotTheClockOrOwnCommits

The epistemic-lease SHALL NOT treat the repository moving since the last `orient()` (for example, the
agent's own commits) as expiry of the agent's model: such divergence SHALL surface as a factual
"repo moved since orient" signal and SHALL at most transition `fresh → degraded`, never force a stale
or critical state. Stale severity (depth) SHALL be driven by accumulated cognitive load, not by
elapsed wall-clock time, so that an idle-but-oriented session does not escalate to the highest severity
on the clock alone.

#### Scenario: The agent's own commits do not expire its model

- **GIVEN** a fresh lease whose `orient` baseline commit differs from the current repository HEAD
- **WHEN** the lease performs its git check
- **THEN** it records the repo-moved fact and transitions at most to degraded, and does not enter a
  stale or critical state from the divergence alone

#### Scenario: Idle time does not escalate severity to critical

- **GIVEN** a stale lease at depth 1 with a low cognitive-load score
- **WHEN** a long period of wall-clock time elapses with only light activity
- **THEN** the stale depth does not escalate on elapsed time alone; severity escalates only with
  accumulated cognitive load (or a genuine activity burst)

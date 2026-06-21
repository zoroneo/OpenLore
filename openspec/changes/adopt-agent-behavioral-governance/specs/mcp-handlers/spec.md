# mcp-handlers spec delta

## ADDED Requirements

### Requirement: AgentBehavioralGovernance

The system SHALL provide an opt-in agent behavioral governance layer that observes per-agent
behavioral destabilization and, in interventional modes, surfaces an advisory signal — computed by
deterministic runtime heuristics, never by an LLM. The layer SHALL be built on the existing
`EpistemicTracker` and reuse the EpistemicLease content-item injection surface; it SHALL NOT alter the
freshness engine (`updateTracker()`), which continues to run in all modes.

The layer SHALL be governed by a single config field `panicResponse.mode` with the ladder
`off | observe | advisory`, defaulting to `off`. In `off`, the layer SHALL perform no scoring, write no
state file, inject no signal, and emit no telemetry. `observe` SHALL score and persist state with no
agent-visible effect. `advisory` SHALL additionally inject a signal as a separate content item (never
concatenated into the result body) at level L2 and above.

All hook-facing commands (`panic-check`, `panic-level`) SHALL fail open — exit 0 on every code path,
including errors and corrupt state. The behavioral state file SHALL resolve to a stable state on
corruption. Telemetry writes SHALL pass through the existing secret-redaction path.

Interventional enforcement (a runtime block decision), the Gryph runtime-observability subsystem and
its background process, and any auto-installed agent hooks are OUT OF SCOPE for this requirement and
SHALL NOT be enabled by default; they are deferred to follow-up changes gated on validated signal
accuracy.

No interventional posture (default `advisory` injection, `experimental_blocking`, or auto-installed
hooks) SHALL ship enabled-by-default until the panic signal's accuracy is validated from `observe`-mode
telemetry on real sessions — a measured false-positive rate low enough that acting on the signal is
net-positive, plus evidence that interventions improve rather than disrupt behavior. Landing the
scoring machinery does NOT satisfy this gate. Until it is cleared, the only sanctioned modes are `off`
(default) and `observe` (silent measurement).

#### Scenario: Intervention stays gated until accuracy is validated

- **GIVEN** the behavioral governance machinery is integrated and green
- **WHEN** a maintainer considers enabling an interventional posture by default
- **THEN** it remains gated until `observe`-mode telemetry demonstrates an acceptable false-positive
  rate and net-positive intervention outcomes — the machinery being present is not itself sufficient

#### Scenario: Default off has zero behavioral footprint

- **GIVEN** a project with no `panicResponse.mode` set (or `mode: 'off'`)
- **WHEN** an agent makes MCP tool calls
- **THEN** no panic scoring runs, no `panic-state.json` is written, no signal is injected, and no panic
  telemetry is emitted — only the existing EpistemicLease freshness behavior occurs

#### Scenario: Advisory injects without corrupting structured output

- **GIVEN** `mode: 'advisory'` and an agent whose behavioral score has reached L2
- **WHEN** a tool returns a structured (JSON) result
- **THEN** the panic signal is appended as a separate content item and the result body remains valid,
  unmodified JSON

#### Scenario: Hook consumer fails open

- **GIVEN** a corrupt or missing `panic-state.json`
- **WHEN** `openlore panic-check` runs as a PreToolUse hook
- **THEN** it resolves to a stable state and exits 0, never blocking the tool call

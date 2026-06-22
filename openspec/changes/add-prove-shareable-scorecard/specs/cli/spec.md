# cli spec delta

## ADDED Requirements

### Requirement: ProveMachineReadableOutput

The `openlore prove` command SHALL support a `--json` mode emitting the scorecard as documented,
stable-keyed JSON to stdout (and nothing else on stdout). The object SHALL carry the cost delta, the
round-trips delta, correctness, per-task cells, the honest verdict, and run metadata (model, runs,
mode, repo SHA, ISO date). The key set SHALL be documented and guarded so it cannot drift silently.
The numbers emitted SHALL be exactly those the run produced — no number the benchmark did not produce
is ever emitted (honesty contract).

#### Scenario: prove emits stable JSON

- **GIVEN** a completed `openlore prove` run
- **WHEN** it is invoked with `--json`
- **THEN** stdout is a single parseable object carrying every documented key, suitable for CI
  consumption, with values matching the run

### Requirement: ProvePersistedDatedScorecards

The `openlore prove` command SHALL support a `--save` mode writing the scorecard and its raw
per-arm/per-task metrics to a dated file under `.openlore/prove/`. Saved results SHALL be keepable and
diffable across runs and SHALL NOT clobber prior dated results, so a user can re-measure after each
optimization phase and track the metric over time (the date-stamped, re-measured discipline the
project applies to its own scorecard, made available on the user's repo).

#### Scenario: prove persists a dated, non-clobbering scorecard

- **GIVEN** `openlore prove --save` run on one date and again on a later date
- **WHEN** `.openlore/prove/` is inspected
- **THEN** it contains two dated scorecard files, each parseable and each matching the corresponding
  run's `--json` output plus its raw metrics

### Requirement: ProveShareableMarkdownAndBadge

The `openlore prove` command SHALL support a `--markdown` mode emitting a paste-ready scorecard block
matching the published Value Scorecard shape (showing wins and losses), and SHALL surface a
shields.io-style badge line derived from the scorecard verdict that a user can place in a README. The
shareable forms SHALL reflect the same honest verdict as the rendered scorecard, never a selectively
favorable subset.

#### Scenario: prove emits a shareable block and badge

- **GIVEN** a completed `openlore prove` run
- **WHEN** it is invoked with `--markdown`
- **THEN** it emits valid markdown containing the headline deltas and the honest verdict, plus a
  well-formed badge line reflecting the scorecard

### Requirement: ProveStaticEstimateArm

The `openlore prove` command SHALL support an `--estimate` mode that computes a deterministic,
no-agent, no-API estimate of the orientation tax a repository carries — over the same graph-derived
tasks the agent arm uses, the from-scratch discovery round-trips a navigator would spend versus the
bounded set `orient` returns — from the call graph alone. The estimate SHALL render with an
unmistakable label distinguishing it from a measured agent run, SHALL function with no `claude` CLI
and no API key, SHALL exit 0, and SHALL NEVER be presented as a measured agent result. The estimate
SHALL invoke no LLM.

#### Scenario: Estimate works without an API key and is labeled as an estimate

- **GIVEN** a repository with an analysis graph but no `claude` CLI and no API key
- **WHEN** `openlore prove --estimate` runs
- **THEN** it emits a deterministic, clearly-labeled estimate of the orientation tax and exits 0,
  without claiming to be a measured agent run

#### Scenario: Estimate never masquerades as measurement

- **GIVEN** an `--estimate` scorecard
- **WHEN** it is rendered in any form (`--json`, `--markdown`, `--save`, or stdout)
- **THEN** its mode is recorded as an estimate and it is visibly distinguished from a measured agent
  result

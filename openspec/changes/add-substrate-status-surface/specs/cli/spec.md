# cli spec delta

## ADDED Requirements

### Requirement: SingleStatusConclusion

The CLI SHALL provide `openlore status [--json]`: a read-only, LLM-free, sub-second
conclusion composing, from existing sources only — index state (existence, age, integrity
verdict, stale-file count, background build/repair in flight with its trigger reason),
active search mode (keyword / local embeddings / remote endpoint), watcher or daemon
liveness for this repo, connected agent surfaces (repo and global scope), governance state
(gate installed, mode, items pending on the human, auto-accepted-unreviewed count, most
recent ledger entries), and version with any cached update availability. Each section SHALL
end with at most one next-action line. On a repo with no OpenLore state, the whole
conclusion SHALL degrade to the single next action (`openlore install`). Sections whose
optional dependencies are absent SHALL render their current truth, never an error. The
command SHALL mutate nothing and SHALL name its sibling conclusions (doctor = environment
health and repair; features = opt-in inventory) in its description.

#### Scenario: The autopilot-era question is answered in one pane

- **GIVEN** a repo with a live watcher, a background repair in flight, and two decisions
  auto-accepted since the user last looked
- **WHEN** the user runs `openlore status`
- **THEN** one pane shows the index as stale-but-repairing with the reason, the search
  mode, the live watcher, and the governance section showing 2 auto-accepted-unreviewed
  with the `openlore decisions review` next action

#### Scenario: A bare repo gets one instruction, not a stack trace

- **GIVEN** a git repo with no `.openlore` directory and no wiring
- **WHEN** the user runs `openlore status`
- **THEN** the output is a short "nothing set up here" conclusion whose single next action
  is `openlore install`, and the exit code is 0

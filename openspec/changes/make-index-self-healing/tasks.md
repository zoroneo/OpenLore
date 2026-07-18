# Tasks — make-index-self-healing

## Implementation
- [ ] Generalize cold-start-bootstrap.ts into `repairInBackground(dir, reason)` — same
      at-most-once latch, never-block/never-throw, env + `autoInit:false` opt-outs; reasons:
      index-absent | integrity-mismatched | stale-region | schema-reset | analysis-age
- [ ] Read-path trigger in mcp-handlers/utils.ts where `computeIndexIntegrity` and the
      stale-region/age checks already run: fire repairInBackground and thread
      "background refresh started" into the freshness note alongside the existing verdict
      (absent vs stale stay distinct)
- [ ] Watcher/daemon graph-rebuild trigger (mcp-watcher.ts, serve.ts): debounced background
      full analyze on stale-region-over-budget or `.git` HEAD change; post-commit hook path
      unchanged
- [ ] Unify the schema-reset rebuild latch through the same service (single coordinator per
      the existing singleflight requirement)
- [ ] `openlore doctor --fix [--yes]`: execute the printed remediations (analyze, install
      --force re-wire); bare doctor stays read-only
- [ ] Anti-thrash latch: a completed repair that still triggers discloses and stops

## Verification
- [ ] Trigger tests: mismatched attestation / stale region over threshold / aged analysis
      each start exactly one background repair; opted-out repo never repairs; absent still
      routes through cold-start behavior unchanged
- [ ] Disclosure tests: response during repair carries staleness verdict + refresh-started;
      never claims fresh; never blocks (latency bound)
- [ ] Watcher tests: branch switch schedules one debounced rebuild; stale-region budget
      crossing schedules one; no rebuild storm under rapid HEAD flips
- [ ] doctor --fix tests: fixes what it printed, nothing else; --yes non-interactive; bare
      doctor byte-identical to today
- [ ] Full suite green; `openspec validate make-index-self-healing` at archive time

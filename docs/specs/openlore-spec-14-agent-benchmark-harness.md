# OpenLore Spec 14 — Agent Token-Efficiency Benchmark Harness (WITH vs WITHOUT)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.
> Parent direction: [Spec 13](openlore-spec-13-context-substrate.md). **Do this spec first.**

---

## Progress

Branch: `openlore-spec-14-agent-benchmark-harness`. **DONE — harness built, two-tier benchmark run (N=4), README cited, navigation-preset fix shipped.**

- [x] Task suite (relational queries where a graph beats grep) + a control task — starter set in
      `scripts/bench-agent.tasks.ts` (callers / blast-radius + a `locate` control); every task has a
      grep-verifiable expected answer; all pass `--verify-oracle` across all 5 repos.
- [x] Harness: drive a headless agent WITH and WITHOUT the openlore MCP server —
      `scripts/bench-agent.ts` (`npm run bench:agent`), `claude -p --output-format json`, MCP toggled
      via `--mcp-config` (`openlore mcp --no-watch-auto`).
- [x] Metric capture: tokens, cost, round-trips (`num_turns`), wall-clock — per task + aggregate.
- [x] Pinned repo set (fixed commit SHAs) — chalk/express/flask/gin/zod, SHAs resolved via `git ls-remote`.
- [x] Committed results doc with a one-command reproduce path — `docs/AGENT-BENCHMARKS.md`
      (methodology + `npm run bench:agent` reproduce path; **results section marked PENDING**).
- [x] Demote the unmeasured README token claim to a hypothesis until results land — done (3 sites,
      linked to AGENT-BENCHMARKS.md).
- [x] **Ran the real paid measurement** (2026-06-01, `--runs 4 --model sonnet`, 56 calls) — results +
      analysis in `docs/AGENT-BENCHMARKS.md`. **Result: openlore did NOT save tokens on this repo set —
      +43% cost / +79% fresh tokens / +38% round-trips, 100% correct in both conditions.** The pinned
      repos are small/famous (the baseline never hit the 15–50k-token orientation tax the claim
      assumes), so this is the wrong arena for the claim, not a refutation. README claim corrected to
      "unproven / not supported by the first benchmark."
- [x] Validated the whole pipeline at $0 via `--dry-run --verify-oracle` (clone → analyze →
      oracle-grep → mock agent → score → aggregate → report). ✓ green on all 5 repos.
- [x] **Round 2 (kill-signal resolved):** studied competitor patterns (CodeGraph/Serena/MCP best
      practices), then added large repos (django/tokio/excalidraw/okhttp) + deep multi-hop trace tasks
      mirroring CodeGraph's set, `--strict-mcp-config` isolation, and a new **`--preset navigation`**
      (7 graph-traversal tools). **N=4 result: openlore flips to a WIN on deep tasks — −7% cost, −26%
      round-trips, scaling with repo size (−21% on ~640–790-file repos), 100% correct.** Two-tier
      verdict (loses on small/shallow, wins on large/deep) documented in `docs/AGENT-BENCHMARKS.md`;
      README corrected to cite the measured numbers. Resolves the #108 kill-signal.
- [ ] **Future levers (DEFERRED — not blocking; spec is DONE):** response compaction (CodeGraph-style "adaptive sizing") to
      grow the cost win toward their 25–35%; capture real tool-call counts via `--output-format
      stream-json`; add to CI as a tracked (non-paid by default) artifact.

---

## Context for you (the agent)

OpenLore's headline value claim — that `orient()` replaces a costly file-by-file orientation
pass — is currently **unmeasured**. The figure in [README.md:19](../../README.md#L19) and
[README.md:50](../../README.md#L50) is an assertion, not a result; [scripts/BENCHMARKS.md](../../scripts/BENCHMARKS.md)
measures only raw EdgeStore query latency (~429µs p50), which is plumbing, not an end-to-end
agent outcome.

This is the single most falsifiable claim in the project, and a competitor (CodeGraph) already
publishes the exact benchmark we lack: median of 4 runs across 7 OSS repos, headless agent,
with/without its MCP server, reporting cost / tokens / tool-calls / wall-clock. We need our own,
apples-to-apples. This harness is also the **kill-signal instrument** from Spec 13: if the
measured reduction on relational queries is small, that is the earliest signal to re-weight
toward the governance layer. And it is the **gate for the entire Layer-3 analysis cluster**
(specs 19–23): those instruments layer on only after this benchmark shows the graph earns its keep.

## Scope contract — do not break these things

This PR must NOT:

- Change any runtime behavior of `orient`, the graph, or the analyzer.
- Modify or remove the existing micro-benchmarks (`scripts/bench.ts`, `scripts/bench-mcp.ts`,
  `npm run bench`, `npm run bench:mcp`) — add alongside them.
- Make network calls part of the core product; the harness is a dev/CI tool only.
- Inflate or hand-pick results. Pin inputs, publish methodology, report losses honestly.

This PR must:

- Add a separate harness (e.g. `scripts/bench-agent.ts`, `npm run bench:agent`) that runs a
  fixed task suite against pinned OSS repos, once WITH the openlore MCP server configured and
  once WITHOUT, capturing tokens / tool-calls / cost / wall-clock.
- Produce a committed, reproducible results document (`docs/AGENT-BENCHMARKS.md`) with the full
  methodology (repos + SHAs, task list, run count, agent + model, how metrics were captured).
- Update the README to cite the measured numbers, and until they exist, mark the token-savings
  line explicitly as a hypothesis pending this benchmark.

## The deliverable

- **Task suite** — queries where a relational graph is structurally cheaper than iterative
  grep+read: enumerate callers of a symbol, blast radius of a signature change, a call path
  between two functions, plus a "find where feature X lives" control task. Tasks must have
  checkable answers so a run can be scored, not just measured. As Layer-3 instruments ship
  (specs 19–23), add their tasks too — e.g. "which tests cover this change?" — so the benchmark
  measures the analysis layer, not just orientation.
- **Harness** — toggles the openlore MCP server in the agent config, runs each task N≥4 times
  per repo across ≥5 pinned repos, and records the metrics. Determinism: pin repo SHAs; fix the
  model; record the agent/CLI version.
- **Results** — a per-repo table plus aggregate, mirroring the competitor's published format so
  comparison is fair. Include variance, not just medians.

## Implementation approach (where it lives)

- **A new script beside the existing benches, not a change to them.** `scripts/bench.ts` and
  `scripts/bench-mcp.ts` measure *query/handler latency* (e.g. the ~429µs p50 orient path) — not
  end-to-end agent tokens. Add `scripts/bench-agent.ts` (`npm run bench:agent`) for the
  WITH-vs-WITHOUT agent runs; leave the latency benches untouched.
- **Toggle the MCP server in the agent config**, run the fixed task suite headless over pinned
  repos, and capture tokens / tool-calls / cost / wall-clock from the agent's telemetry.
- **Reuse the clean-repo dogfooding approach** from the `first-run-hardening` skill for setup.

## Compatibility verification (grounded 2026-05-30)

- **Pure addition:** a new script + `docs/AGENT-BENCHMARKS.md`. No runtime, library, or API change.
  The existing benches and their `npm run bench` / `bench:mcp` entry points are unmodified.

## Notes

- Keep both stories: the micro-benches are the *latency* story; this is the *token / round-trip*
  story. They answer different questions.
- Mirror CodeGraph's methodology (median of N≥4 runs, ≥5 repos, headless, with/without) so the
  comparison is apples-to-apples and not dismissible.

## Acceptance

- A reviewer runs one documented command and reproduces the table.
- Numbers are committed in `docs/AGENT-BENCHMARKS.md`; the README cites them (or marks the claim
  as a pending hypothesis).
- If the reduction on relational queries is below the Spec 13 kill-signal threshold, open a
  follow-up to re-weight toward the governance layer — do not bury the result.

## Compatibility note

Pure addition: a new dev/CI script and a docs file. No user-facing or runtime change.

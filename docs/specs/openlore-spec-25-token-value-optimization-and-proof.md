# OpenLore Spec 25 — Token-Value Optimization & Honest Proof

> **Brainstorm / architecture spec. No code is written in this session.** This is a wander toward a
> concrete program: make OpenLore *provably* save an agent more than it costs, and show that proof
> honestly and prominently. Parent: [Spec 13](openlore-spec-13-context-substrate.md) (substrate),
> [Spec 14](openlore-spec-14-agent-benchmark-harness.md) (the benchmark we already have).
> Prompt provocation: the `headroom` project (context compression for agents).

---

## Progress

Phasing in §8 (prove → optimize → re-prove). Implementation branch:
`feat/spec-25-value-scorecard`.

Status: **Phases A–D + the honesty guard shipped; the empirical re-prove (Phase E) is now in scope
and underway.** Earlier this PR delivered the code/deterministic half and *deferred* the actual
benchmark run as API-budget-gated. That deferral is rescinded: Phase E runs the agent benchmark live
on this machine, measures whether the lean surface moves the small-repo loss (§3), refreshes the
scorecard from real numbers, and iterates on the surface if the loss persists. We report whatever we
measure — including a loss that does not fully close — per the honesty contract.

- [x] **Phase A — Prove the present, honestly.** README [Value Scorecard](../../README.md#value-scorecard--does-it-pay-for-itself)
  built from the existing measured Spec-14 data (Round-1 loss + Round-2 win, **including the loss
  cells**), above the fold; replaced the unproven "15–50k tokens" / "replaces 10+ file reads"
  estimates with measured cost/round-trip deltas **in the README, the orient skill, and the install
  template**; wrote the [honesty contract](../AGENT-BENCHMARKS.md#honesty-contract-spec-25) into the repo.
- [x] **Phase B — Cache + lean surface (P1).** Cache-prefix **stability regression test** (tools/list
  byte-identical across requests; static schemas; declaration-order filtering) — the win depends on a
  cacheable prefix. Documented the lean surface (deferred schemas preferred; `--preset navigation`)
  tied to the benchmark. Fresh-vs-cached is already instrumented in the harness. *Did not* force the
  install default to navigation (would hide the governance tools the decision gate needs) — opt-in +
  recommended instead.
- [x] **Phase C — Progressive disclosure + adaptive sizing (P2–P4).** Every orient/search_code item
  carries an exact `expand` handle (`name::filePath`); optional `tokenBudget` greedily keeps the
  highest-scored results that fit (exact duplicates collapsed first, P3), overflow → an `*Omitted`
  note. Threaded through the MCP tools + the `orient --token-budget` CLI flag. Default unchanged.
- [x] **Phase D — `openlore prove` (Q2).** New command + shipped `src/core/agent-eval/` core: runs a
  WITH/WITHOUT pass over graph-derived, oracle-able tasks on the user's own repo and prints a personal
  scorecard (cost/round-trips/correctness Δ + honest verdict). Agent call behind an injectable runner
  (unit-tested, no API spend); `--dry-run` previews; real runs need `claude` + an API key.
- [x] **Honesty guard test** (`src/honesty-contract.test.ts`) — the contract is now executable: the
  README's published figures must match a reviewed canonical set, and the retired estimates can't
  reappear in any shipped surface.
- [x] **Phase E — Empirical re-prove (Q1 + §3), run live 2026-06-03.** Ran the agent benchmark on this
  machine (`claude-sonnet-4-6`, `--preset navigation`, --strict-mcp-config). Findings in
  [AGENT-BENCHMARKS.md → Round 3](../AGENT-BENCHMARKS.md#round-3--live-re-prove-on-this-machine-2026-06-03-spec-25-phase-e):
  1. **Deep win reproduced** — okhttp **−13%, identical to Round 2** (and unchanged by the Phase C
     edits): the win is real and stable.
  2. **§3 loss NOT eliminated, and it's task-dependent** — chalk **−32% (win)** vs express **+59%
     (loss)** on the same small-repo class. The cost is a sometimes-redundant `orient` round-trip, not
     tool-schema bytes, so a leaner surface does not close it. Reported plainly rather than claimed fixed.
  3. **`openlore prove` validated live** and a real weakness fixed: its first run scored 0%/33% because
     the auto-derived "most-called function?" task was ambiguous; replaced with robust file-locate +
     caller/callee oracles → 67%/67%, honest "doesn't help here" verdict on this repo's shallow tasks.
  4. **Scorecard refreshed** (README + AGENT-BENCHMARKS.md Round 3 + honesty-guard constants) from the
     fresh, dated numbers — including the losses.

---

## 0. The proposition, stated bluntly

OpenLore has exactly one reason to exist: **an agent *with* OpenLore must reach a correct answer
for less total cost than the same agent *without* it.** If that is not true, the tool is negative
value and should not ship. Everything below serves that single inequality:

```
cost_with_openlore(correct answer)  <  cost_without(correct answer)
```

"Cost" is dollars first, then its drivers: fresh (uncached) input tokens, round-trips, wall-clock.
We will not hide behind a synthetic "tokens replaced" estimate. We will measure the inequality,
publish it — wins **and** losses — and let users measure it on their own code.

This spec has two halves that must ship together: **(A) optimize the inequality** and **(B) prove
it, transparently.** Optimization without proof is marketing; proof without optimization is an
honest admission of low value. We want both.

---

## 1. Ground truth — what we have actually measured (no spin)

From [docs/AGENT-BENCHMARKS.md](../AGENT-BENCHMARKS.md) (Spec 14 harness: `claude -p
--output-format json`, N=4, pinned SHAs, `--strict-mcp-config` isolating each arm):

- **Round 1 — small/familiar repos, shallow "who calls X" tasks (chalk/express/flask/gin/zod):
  OpenLore *lost*.** Median **+43% cost, +79% fresh input tokens, +38% round-trips**, losing 5 of 7
  tasks. Correctness was **100% in both arms** — so it bought no accuracy either. Reported as-is.
- **Root cause was the tool surface, not the responses.** The full ~45-tool MCP schema is sent on
  every request; when the agent never calls most of those tools, their JSON Schemas are pure
  per-request overhead that *erased* any saving. The responses themselves are already small.
- **Round 2 — large repos, deep multi-hop traces, with `--preset navigation` (7 tools):** **−7%
  cost, −26% round-trips, fresh tokens ≈ flat**, and the win **grows with repo size** (Django/Tokio/
  Excalidraw −7%…−21%; Gin, the smallest, break-even +4%). The most consistent signal is
  round-trips: fewer tool calls to reach the answer on *every* deep task.
- **The README headline is an estimate.** "`orient()` … replaces 10+ file reads" and "~1–3k vs
  15–50k tokens" ([README.md](../../README.md)) are intuitions, explicitly footnoted as unproven.

**Two-tier conclusion, stated honestly:** OpenLore wins where the *orientation tax* is real (large,
unfamiliar codebases the model has not memorized, deep multi-hop questions) and loses where it isn't
(small, famous repos already in the model's weights). The whole program below is: **widen the win,
kill the loss, replace every estimate with a measured, reproducible number.**

---

## 2. What `headroom` teaches — and what we deliberately reject

`headroom` compresses everything an agent reads (tool output, files, RAG, logs, history) by
**60–95%** and — critically — **proves answer quality is preserved** with a reproducible eval suite
(GSM8K/TruthfulQA/SQuAD/BFCL, `python -m headroom.evals`). Its mechanisms: content-aware compressors
(JSON "SmartCrusher", AST "CodeCompressor", a trained "Kompress" model), a **CacheAligner** that
stabilizes prefixes for provider KV-cache hits, **reversible compression** (originals stored locally,
the LLM calls `headroom_retrieve` to expand), **importance-scored** context fitting to a budget, and
cross-agent dedup memory.

**Adopt — as deterministic, offline mechanisms:**

| headroom idea | OpenLore form |
|---|---|
| Reversible compression (store original, retrieve on demand) | **Progressive disclosure** — return the smallest sufficient *structural fact* plus an **exact** expansion handle (`symbol::file`, `file:line`). Our IDs are deterministic, so expansion is exact, not fuzzy. We already half-do this (`get_function_body`/`get_function_skeleton`); make it the contract. |
| CacheAligner (stable prefix → KV-cache hits) | **Cache-stable tool surface** — fixed tool ordering + pinned schema/preamble text so the provider caches it and per-request schema cost drops ~10×. Directly attacks the Round-1 root cause. |
| Importance-scored budget fitting | **Token-budgeted responses** — optional `tokenBudget`; importance-rank deterministically, greedily fill, replace overflow with expansion handles. |
| Content-aware compaction | **Deterministic compaction only** — extend skeletonization; collapse near-duplicate implementations to one exemplar + count + deltas (reuse `get_duplicate_report`). |
| Reproducible eval proving quality preserved | **Honest, prominent, reproducible proof** (§5) — including a self-serve "measure it on your repo" command. |

**Reject — these violate OpenLore's north star (deterministic, local-first, offline, no API key):**

- **Trained ML compressors / image routers** (`Kompress`, the ML image router). Non-deterministic, a
  heavy dependency, and they'd make the substrate's output depend on a model — the opposite of
  "deterministic structural context." Our payloads are already 15–25 KB and *structured*; squeezing
  bytes with a model buys little and costs determinism.
- **A network proxy / provider interception** (headroom's port-8787 proxy). OpenLore is plumbing the
  agent calls *into*, not a man-in-the-middle on the model call.
- **Lossy semantic compression of code.** A graph substrate must not paraphrase code; it points at
  exact code. Compression here = *fewer, more precise facts + exact handles*, never *fuzzier facts*.

The senior-engineer read: **headroom optimizes the bytes of a turn; OpenLore should optimize the
*number of turns* and the *cache economics* of the turn.** Those are bigger levers for our use case,
and they're deterministic.

---

## 3. The reframe that should drive everything

The Round-2 data says the win is **−26% round-trips**, with fresh tokens roughly flat. That is the
tell. Our value is not "smaller responses" — it's **fewer agent turns to a correct answer** and
**avoided wrong-path exploration**. Each avoided round-trip saves a whole model turn re-reading an
ever-growing context; that dwarfs a few KB shaved off one response.

So the optimization priorities, ranked by expected leverage:

1. **Cache economics of the surface** (fresh→cached) — the schema overhead only hurts when it isn't
   cached. Make it cacheable and lean. *Biggest, cheapest win; fixes the Round-1 loss.*
2. **Round-trips per task** — make `orient` and the traversal tools *complete* enough that the agent
   stops looping. (This is already our strength; protect and extend it.)
3. **Minimal-sufficient responses with exact expansion handles** — keep each turn small *without*
   forcing a follow-up read, because a follow-up read is a round-trip (priority 2 again).
4. **Raw byte compaction** — last, and only deterministically.

Note the elegant tension: aggressive response trimming (priority 3) can *increase* round-trips
(priority 2) if it strips something the agent then has to re-fetch. The resolution is the
progressive-disclosure contract: trim to the smallest fact **that still lets the agent decide**, and
attach the exact handle so expansion is a *cheap, optional, one-shot* call — not a blind re-search.

---

## 4. Optimization program (deterministic)

### P1 — Cache-aware, lean-by-default tool surface
- Make a lean preset (today's `navigation`, 7 tools) the **recommended default** for agents, and
  document the full surface as opt-in. The benchmark already shows this flips +43% → −7%.
- **Stabilize the cache prefix:** fixed tool-definition order, pinned schema/preamble strings, no
  per-request variation, so the provider KV-cache holds the surface and it costs ~10× less after the
  first call. Treat any per-request churn in the preamble as a bug.
- **Explore deferred/lazy tool schemas:** advertise tool *names* cheaply and load a tool's full
  JSON Schema only when it's about to be used (the pattern this very runtime uses for deferred
  tools). If viable over MCP, it drives first-call schema overhead toward zero — potentially erasing
  the Round-1 loss outright. Open question in §7.
- **Instrument fresh-vs-cached explicitly** in the harness so we can *see* the cache working.

### P2 — Progressive-disclosure contract (OpenLore's reversible compression)
- Principle: **every tool returns the smallest sufficient structural fact + an exact expansion
  handle.** `orient` returns signatures + `symbol::file` / `file:line` pointers, not bodies; the
  agent expands exactly one body via `get_function_body` *only if it needs to*.
- This is headroom's CCR, but **exact** instead of fuzzy — our determinism is the moat.
- Make handles first-class and uniform across tools (a stable `expand:` field), so an agent learns
  one expansion idiom.

### P3 — Adaptive sizing / duplicate collapsing (the CodeGraph lever AGENT-BENCHMARKS flagged)
- When results share a shape (overloads, near-duplicate handlers, generated code), collapse to **one
  exemplar + a count + the deltas**, reusing existing duplicate detection. 10–50× on duplicate-heavy
  results, zero loss of decision-relevant information.
- Signatures by default; bodies on request (P2).

### P4 — Token-budgeted responses
- Optional `tokenBudget` on `orient`/`search_code`: importance-rank deterministically (existing
  scores), greedily fill the budget, and replace the overflow with a single line: "*N more —
  expand with `…`*". Deterministic, reproducible, and lets a caller fit the answer to a context
  window on purpose.

### P5 — Deterministic content compaction (lowest priority)
- Extend skeletonization; prefer compact structured JSON over prose; drop fields that repeat the
  query. Never at the expense of an expansion handle or correctness.

---

## 5. The proof program (honest, transparent, prominent)

This is the half the user is really asking for: **prove the value, show it clearly, link it in the
README, and never overstate it.**

### Q1 — Re-base the benchmark on the *real* target, keep the loss case as control
- **Corpus:** large, unfamiliar/private-shaped repos + **deep multi-hop tasks** (where orientation
  tax is real) as the headline; **keep** the small/familiar repos as the honest control that *shows
  the loss*. Choose the corpus and tasks **before** looking at results (anti-cherry-pick).
- **Metrics:** end-to-end **USD cost (primary)**, fresh tokens, **cached tokens (new — see P1)**,
  **round-trips (co-headline)**, correctness, wall-clock — WITH vs WITHOUT, N runs, median + spread.
- Reuse the Spec 14 isolation discipline (`--strict-mcp-config`, pinned SHAs).

### Q2 — `openlore prove`: measure it on *your* repo (the strongest honesty mechanism)
- A command that runs a quick WITH/WITHOUT pass on **the user's own codebase** over a couple of
  seeded/auto-derived tasks and prints a **personal token-value scorecard**: cost delta, round-trip
  delta, correctness, "helps / break-even / doesn't help here."
- Reframes the whole trust problem: *"Don't trust our numbers on famous repos — measure yours."*
  This is the most credible possible answer to "is it actually a value add?"
- Must surface its own caveats: LLM nondeterminism → N runs + median + variance; needs an API key
  for the agent arm; states clearly when the sample is too small to conclude.

### Q3 — A README "Value Scorecard," prominent and linked
- A table near the top: **task class × repo size → cost Δ, round-trip Δ, correctness** — *including
  the cells where OpenLore loses or breaks even.* Honesty is the feature.
- A one-line **reproducible command**, the **pinned SHAs/date**, and ideally a **badge**.
- A blunt **"when OpenLore helps / when it doesn't"** box that sets expectations before install.
- Replace the unproven "15–50k tokens" estimate with measured ranges, or delete it.

### Q4 — Honesty contract (written into the repo)
- Never publish a savings number the harness didn't produce.
- Always show the negative cases alongside the positive.
- Re-measure and update the scorecard after each optimization phase; date-stamp it.
- Consider a nightly CI benchmark so the README number is never stale (cost/flakiness tradeoff in §7).

---

## 6. Non-goals

- No trained models, no network proxy, no API key for the *substrate* (the benchmark/`prove` agent
  arm needs one; the tool itself must not).
- No lossy/semantic compression of code; no fuzzy retrieval. Exact handles only.
- Not chasing raw byte reduction for its own sake — round-trips and cache first.
- Not re-litigating the two-tier reality: small/familiar repos may stay break-even, and that's fine
  *if we say so plainly.*

## 7. Risks & open questions (the wandering part)

- **Is "round-trips" the more honest headline than "tokens"?** I lean yes — it's what we actually,
  consistently move, and it's harder to game. Tokens/cost stay as the bottom line.
- **Can MCP tool schemas be deferred/lazy** the way this runtime defers tools? If yes, P1 may erase
  the small-repo loss entirely. Needs an MCP-capability check — biggest unknown, biggest upside.
- **LLM nondeterminism** threatens any benchmark. Mitigate with N runs, median, published variance,
  pinned models/SHAs — and admit the residual.
- **Cache behavior is provider-specific.** Measure it; don't assume a 10× on faith.
- **Over-trimming raises round-trips.** Every compaction must keep the exact expansion handle and be
  gated on "correctness preserved" in the harness.
- **Benchmark cost vs freshness.** A live nightly badge is great honesty but burns API budget and can
  flake; maybe a cheap proxy metric (round-trips on a tiny pinned corpus) for the badge, full suite
  on demand.
- **Scope discipline.** This must not drift into a general compression library. It's: lean cacheable
  surface + progressive disclosure + a credible, self-serve proof.

## 8. Phasing (proposal — prove first, then optimize, then re-prove)

- **Phase A — Prove the present, honestly.** Re-based benchmark (Q1) + README Value Scorecard (Q3) +
  replace the unproven estimates with measured numbers (Q4). Ship the truth as it stands today.
- **Phase B — Cache + surface (likely the biggest win).** Lean default + cache-stable prefix +
  fresh/cached instrumentation (P1). Re-measure; expect the small-repo loss to shrink toward break-even.
- **Phase C — Progressive disclosure + adaptive sizing.** Minimal-sufficient responses with exact
  handles (P2), duplicate collapsing (P3), `tokenBudget` (P4). Re-measure round-trips.
- **Phase D — `openlore prove`.** The self-serve, on-your-repo scorecard (Q2). The honesty capstone.
- Re-measure and republish the scorecard after **every** phase. The number in the README is always
  the last measured number, with its date.

## 9. Success criteria

Honest status after Phase E (2026-06-03):

- ✅ The README carries a **measured, reproducible** value scorecard — wins *and* losses — linked
  prominently above the fold.
- ✅ On the target corpus, WITH-OpenLore beats WITHOUT on **cost and round-trips at equal correctness**,
  by a margin that **grows with repo size** — re-confirmed live (okhttp −13%, reproducing Round 2).
- ❌ **The small/familiar-repo loss is NOT eliminated.** Phase E showed it's task-dependent (chalk
  −32% vs express +59%) and rooted in a sometimes-redundant `orient` round-trip, which a leaner
  surface (P1) does not remove. We report this rather than claim a fix. Honest mitigation: `openlore
  prove` lets a user see the per-repo verdict themselves.
- ✅ Anyone can run **`openlore prove`** on their own repo and get an honest personal number in
  minutes (validated live; oracle hardened so correctness is meaningful).
- ✅ Every public token claim traces to a command someone else can run (enforced by the honesty-guard test).

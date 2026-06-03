# OpenLore Spec 27 — Lean / Adaptive Orientation (kill the shallow-task overhead)

> Direct follow-up to **Spec 25 Phase E**, which measured the one unsolved loss honestly:
> on shallow questions / small familiar repos, an agent **with** OpenLore can cost *more* than
> without, and the navigation preset did **not** close it. This spec attacks that loss with a
> deterministic, offline mechanism and re-measures. Parent: [Spec 25](openlore-spec-25-token-value-optimization-and-proof.md).

---

## Progress

Branch: `feat/spec-27-lean-orientation`. Implementation lands incrementally; the scorecard is
re-measured live and refreshed honestly (Spec 25 honesty contract applies).

- [x] **P1 — Lean orient response.** `lean` mode returns only the navigation core + `expand` handles,
  dropping the enrichment blocks. Measured **2269 → 1357 tokens (40% smaller)** on this repo. MCP tool
  option + `orient --lean` CLI flag; unit-tested; rich default unchanged.
- [x] **P2 — Wire lean into the navigation path.** Skill guidance added (use `lean:true` for shallow
  who/where lookups; omit it when you need specs/decisions/insertion-points). Benchmark `--lean-orient`
  flag added to drive the measurement.
- [x] **P3 — Re-measured live (2026-06-03). Honest result: lean does NOT close the shallow-task loss.**
  express "who calls X" with lean orient: WITHOUT $0.024 / 3 turns vs WITH-lean $0.049 / 5 turns
  (**+107%**) — no better than rich orient (+59% earlier). The loss is **structural**: on a trivial
  lookup in a famous small repo the baseline already finishes in ~3 turns / ~1.9k tokens, so *any*
  orient call (lean or rich) — one extra round-trip + its response — costs more than the whole answer.
  Lean cuts the *payload* 40% (helps every orient call, especially deep ones and borderline cases) but
  cannot remove the *round-trip*, which is the dominant cost on trivial tasks. Reported, not buried.
- [ ] **P4 — Advisory orientation (explored, NOT implemented).** The only lever left for the trivial
  case is *not making the orient round-trip at all* — but the data is a coin-flip (chalk benefits from
  orienting, express doesn't), and an agent can't reliably tell ahead of time, so forcing the choice
  risks the deep-task win. We deliberately do not ship a heuristic that guesses. The honest answer
  stays: `openlore prove` lets each user measure their own repo + task mix.

**Net (honest):** lean orient is a real, shipped efficiency improvement (40% smaller orient payload,
deterministic, no downside — enrichment stays one `expand` away). It does **not** eliminate the
small-repo/shallow-task loss, which is structural. We ship the win and report the limit plainly.

---

## 1. The measured problem (Spec 25 Phase E, 2026-06-03)

On shallow "who calls X" tasks the WITH arm is cost-positive in two ways:

1. **Payload tokens.** A single `orient` call on this repo is **~2,269 tokens**, of which the
   navigation core (`relevantFunctions` + `callPaths`) is ~39% and the rest is enrichment a shallow
   lookup never uses:

   | block | share | needed for "who calls X"? |
   |---|---|---|
   | relevantFunctions | 23% | yes (core) |
   | callPaths | 16% | yes (core) |
   | provenance | 12% | no |
   | insertionPoints | 8% | no (editing tasks only) |
   | changeCoupling | 7% | no |
   | nextSteps (prose) | 3% | no |
   | (plus `inlineSpecs` / decisions when present — often the largest blocks) | | no |

2. **A sometimes-redundant round-trip.** express "who calls X": WITHOUT 4 turns, WITH 6 (the forced
   orient call added turns on a task the model could finish in 4). chalk, by contrast: 6 → 3 (orient
   collapsed real exploration). Same repo class, opposite outcomes.

**Conclusion.** ~30–60% of an orient payload is enrichment irrelevant to a navigation lookup, and that
enrichment is pure overhead exactly where OpenLore already struggles. Trimming it is a deterministic,
safe win that shrinks the per-call cost on every task and proportionally most on the shallow ones.

## 2. Mechanism — `lean` orient (P1)

Add an opt-in `lean` mode to `orient` that returns the **minimal-sufficient orientation**:

- **Keep:** `task`, `searchMode`, `note`, `relevantFiles`, `relevantFunctions` (with `signature` +
  `expand` handles), `callPaths`, `specDomains`.
- **Drop (reachable via the rich call or dedicated tools):** `insertionPoints`, `provenance`,
  `changeCoupling`, `inlineSpecs`, `matchingSpecs`, `pendingDecisions`, `governingDecisions`,
  `architectureViolations`, `specLinkedFunctions`, `nextSteps`.

This composes with Spec 25's progressive-disclosure contract: everything dropped is one exact
`expand` handle or one dedicated tool call away, so lean trims *bytes per turn* without forcing a
follow-up *round-trip* (the failure mode §3 of Spec 25 warned about). Default stays rich (backward
compatible); `lean` is opt-in via the MCP tool, the `orient --lean` CLI flag, and the navigation path.

## 3. Non-goals

- Not lossy: lean never paraphrases or drops *correctness-relevant* facts — it drops enrichment that
  has an exact expansion handle.
- Not a new default for the rich call: existing callers keep the full payload unless they ask for lean.
- Not claiming this fully eliminates the small-repo loss — the round-trip cost is partly structural.
  We measure and report honestly (it may move express-style cases toward break-even, not past it).

## 4. Success criteria

- `orient --lean` returns the navigation core only, every function still carries an `expand` handle,
  and the payload is materially smaller (target: ≥30% fewer tokens on a typical task), unit-tested.
- The deep-task win is **unchanged** (lean is only used where enrichment isn't needed; the rich call
  is untouched).
- A live re-measure quantifies the shallow-task overhead reduction; the scorecard is refreshed with
  the fresh numbers — including whatever the result is.

# OpenLore Spec 13 — Product Direction: A Deterministic Structural Context Substrate for AI Coding Agents

> This is a **strategy + architecture** spec, not a single-PR prompt. It defines the
> direction every subsequent spec should serve.
>
> **Prime directive (read first):** OpenLore is, and remains, a tool for **AI coding agents**.
> Everything in this document is **additive**. Nothing here removes, replaces, or repositions
> the current product. We grow *up* (deeper, better-proven code intelligence) and *out*
> (adjacent developer context — infra, decisions, provenance), never *away* from the coding
> agent. Every new capability must make the existing coding-agent use case more useful, or it
> does not ship. See "Compatibility & scope guarantee" below.
>
> **Revision note (2026-05-30):** the first draft of this spec overstated several things
> (a built "code↔org join," "bidirectional SCIP," a published token-savings benchmark, a
> Zed integration). A verification pass against the codebase and primary sources corrected
> them. This revision is deliberately **honest about what exists vs. what is aspirational** —
> because the entire bet depends on claims a reviewer can check in 60 seconds.

---

## Progress

Branch: `openlore-spec-13-context-substrate`. Direction locked; claims verified; roadmap is benchmark-first.

- [x] Strategic lens chosen by owner (2026-05-29): **substrate/plumbing**, not breadth-product
- [x] Competitive + market reality verified against primary sources (2026-05-30)
- [x] Repo ground-truth established (what actually ships vs. what was claimed)
- [x] Theses adversarially stress-tested; positioning corrected to survive the strongest attack
- [x] **Spec 13.1** — Make Incremental Freshness Cheap (Watch-Mode Performance). **Shipped in v2.0.6** (PRs #102/#103/#106). Field-validated on enklayve's real 2.1 MB corpus: a 15-file burst dropped from ~5,900 ms / 46 stderr lines (2.0.5) to 443 ms / 2 (2.0.6); next-call read after a save from a 4.6 ms cold re-parse to a 0.03 ms cache hit. → [openlore-spec-13.1-watch-mode-performance.md](openlore-spec-13.1-watch-mode-performance.md)
- [ ] **Spec 14** — Agent Token-Efficiency Benchmark Harness (WITH vs WITHOUT). *Do this first (after 13.1).* → [openlore-spec-14-agent-benchmark-harness.md](openlore-spec-14-agent-benchmark-harness.md)
- [x] **Spec 15** — Decision & Drift Governance Dogfooding (turn the gate on in our own repo). **Done** (PR #109). → [openlore-spec-15-governance-dogfooding.md](openlore-spec-15-governance-dogfooding.md)
- [x] **Spec 16** — Architectural Decisions as First-Class Graph Nodes (`affects` edges). **Done** — decision store projects to `decision::` nodes + `affects` edges; `analyze_impact`/`get_subgraph`/`orient` surface governing decisions; `SCHEMA_VERSION` 2→3. → [openlore-spec-16-decisions-as-graph-nodes.md](openlore-spec-16-decisions-as-graph-nodes.md)
- [ ] **Spec 17** — Cross-Domain Impact Analysis (Code ↔ Infrastructure). → [openlore-spec-17-cross-domain-impact.md](openlore-spec-17-cross-domain-impact.md)
- [ ] **Spec 18** — Local Provenance Edges (Git & PR metadata, no OAuth). → [openlore-spec-18-local-provenance-edges.md](openlore-spec-18-local-provenance-edges.md)
- [ ] **Spec 19** — Deterministic Test Impact Selection (headline Layer-3 instrument). → [openlore-spec-19-test-impact-selection.md](openlore-spec-19-test-impact-selection.md)
- [ ] **Spec 20** — Reachability & Dead-Code Analysis. → [openlore-spec-20-reachability-dead-code.md](openlore-spec-20-reachability-dead-code.md)
- [ ] **Spec 21** — Structural Change Analysis (graph diff). → [openlore-spec-21-structural-change-analysis.md](openlore-spec-21-structural-change-analysis.md)
- [ ] **Spec 22** — Change-Coupling & Volatility Analysis. → [openlore-spec-22-change-coupling-volatility.md](openlore-spec-22-change-coupling-volatility.md)
- [ ] **Spec 23** — Architecture Invariant Guardrails. → [openlore-spec-23-architecture-invariants.md](openlore-spec-23-architecture-invariants.md)
- [ ] **Horizon 3 (optional, may never ship)** — cloud OAuth connectors as a fire-walled plugin. Deliberately *not* a numbered spec until 14–23 land and prove the local-first thesis.

---

## Context — the decision and what it cascades

OpenLore today is a **deterministic, local-first code context engine**: a tree-sitter call
graph + clusters + McCabe (no API key), an optional LLM spec/decision layer, and a 45-tool
MCP runtime fronted by `orient()`.

The owner chose the **substrate/plumbing** lens (be the layer others build on, like
tree-sitter / SCIP / LSP), not the Glean-style breadth product. That single choice cascades:

1. **Whose permissions?** → local-first ⟹ **token-scoped, not org-wide.** No ACL-mirroring
   engine (Glean's moat *and* its tarpit). Our user is the developer and their agent, not IT.
2. **Build connectors or ride MCP?** → substrate ⟹ ride existing MCP connectors where org
   data is ever needed; do not re-implement OAuth twelve times.

The rest of this spec is about getting the *positioning* right, because the lens alone does
not survive contact with the 2026 market without a sharper claim.

---

## Compatibility & scope guarantee (the prime constraint)

OpenLore's installed product is: `openlore analyze` → `CODEBASE.md` + `orient()` over MCP for
coding agents, with optional specs/decisions/drift. **That contract is frozen. This direction
adds to it; it does not change or break it.** Concretely:

- **The CLI surface is preserved.** `analyze`, `generate`, `drift`, `decisions`, `export scip`,
  `manifest`, `install`, `mcp` continue to behave as today. New work adds new subcommands/flags,
  never repurposes existing ones.
- **`orient()`'s response shape is treated as a public API.** New fields are additive and
  optional; existing fields keep their meaning. A 2.x agent integration must not break.
- **No API key remains required for the core.** Layer-1 determinism (graph, `orient`,
  `CODEBASE.md`) stays offline and key-free. Everything network/LLM stays optional, as today.
- **Graph schema changes are safe by construction.** The edge store is keyed on `SCHEMA_VERSION`
  and rebuilds from source on a version bump ([edge-store.ts](../../src/core/services/edge-store.ts)).
  The graph is *derived*, never hand-authored, so a schema addition costs users one re-analyze —
  not a migration, not data loss.
- **Every new capability serves the coding agent.** Code↔infra impact, decision/provenance edges,
  and the benchmark are all things a coding agent uses *while working on code*. The one item that
  drifts toward non-coding context — cloud org connectors — is fenced to an optional Horizon-3
  plugin that is never installed by default and never on the core path.

**The test for any future PR under this spec:** *does it make today's coding-agent workflow
strictly better or strictly broader, while leaving every current behavior intact?* If not, it
does not belong here.

### Compatibility verification (grounded against the code, 2026-05-30)

A read-only pass over the subsystems specs 14–23 touch confirms the additions are additive, and
names the *specific mechanism* that makes each safe — so this is evidence, not assertion:

- **New edge kinds are safe.** Nothing in the codebase switches *exhaustively* on `EdgeKind`. The
  only pattern that inspects it is the defensive filter `e => !e.kind || e.kind === 'calls'`
  ([call-graph.ts](../../src/core/analyzer/call-graph.ts#L39) and the analysis handlers), so a new
  kind is simply *excluded* from call-only logic by default — it cannot break existing traversal.
  A filter opts a new kind in explicitly only where wanted. This is exactly how the IaC
  `references`/`depends_on` kinds already coexist with `calls`.
- **New node types are safe.** Nodes live in dedicated tables (`nodes`, `classes`); a new type
  (e.g. decision nodes, Spec 16) adds a table and bumps `SCHEMA_VERSION`. On a bump the edge store
  **drops and rebuilds from source** ([edge-store.ts](../../src/core/services/edge-store.ts),
  `SCHEMA_VERSION = 2`) — no migration, no data loss, one re-analyze.
- **Retrieval cannot break, because tool responses are additive by contract.** `orient`,
  `analyze_impact`, and `get_subgraph` return `unknown`; consumers *cast* (`as OrientResult`), they
  do not schema-validate. Adding optional fields is invisible to them. The only discipline is:
  *never remove or retype an existing field.*
- **The analysis instruments reuse existing traversal.** `bfs()` / `bfsFromDB()` /
  `buildAdjacency()` ([graph.ts](../../src/core/services/mcp-handlers/graph.ts)) already power
  `analyze_impact` and `get_subgraph`; test selection, reachability, and structural diff are new
  *callers* of these primitives, not changes to them.
- **Decisions, drift, and git are untouched in shape.** The decision file format
  (`.openlore/decisions/pending.json`, `version: '1'`) and the gate are unchanged by Spec 16
  (the graph projection is derived and optional). The drift detector already excludes `docs/`
  ([drift-detector.ts](../../src/core/drift/drift-detector.ts)). Git is read locally via
  [git-diff.ts](../../src/core/drift/git-diff.ts) (`execFile('git', …)`; no `gh` today); Specs
  18/22 add new read functions beside the existing ones.
- **Benchmarks are added, not modified.** `scripts/bench.ts` and `scripts/bench-mcp.ts` measure
  query/handler latency; Spec 14 adds a new end-to-end script beside them.

**Net:** every instrument is a new *reader* of existing data, plus at most an additive edge kind
or node table behind a `SCHEMA_VERSION` bump. Retrieval is a hard dependency of analysis, so it is
preserved *by construction* — we build **on** it, never around it.

## How the shape of the product changes

This is growth along the axis OpenLore already chose, not a turn onto a new one:

| | Today | After specs 14–23 (still local, still key-free, still coding-first) |
|---|---|---|
| **Core artifact** | Deterministic code call graph | Same graph, now spanning code **+ infrastructure + decisions** on one primitive |
| **What `orient()` answers** | who-calls / what-breaks / call-path / insertion points / spec matches | + code→infra blast radius; + "who last changed this, under which PR/decision" |
| **What it can *compute* (Layer 3)** | shallow callers / direct impact | + which tests to run, reachability/dead-code, structural diff of a change, change-coupling, invariant checks |
| **Decisions** | LLM-extracted, stored in a side-file, surfaced by a string filter | First-class graph nodes with `affects` edges, traversable by `analyze_impact` |
| **Evidence** | "saves 15–50k tokens" (unmeasured claim) | A reproducible WITH-vs-WITHOUT benchmark, published |
| **Audience** | Coding agents | **Unchanged** — coding agents |
| **Network** | Optional (specs/LLM only) | **Unchanged** — core stays offline; cloud is opt-in Horizon-3 only |

The product goes from *"a map of your code"* to *"the always-fresh map of your code — the infra
it deploys to and the decisions that shaped it — plus the deterministic analysis (impact, tests,
coupling, invariants) computed over it"* — a wider view of **the same developer's world**, for
**the same audience**, with **the same local-first, deterministic guarantees**. That is "grow up
and out," not pivot.

---

## The verified market reality (2026)

**Several leading coding agents have de-emphasized embedding-based RAG for code *navigation*
in favor of on-demand agentic search (grep/glob/file-reading).** This is real and primary-sourced,
but "RAG is dead for coding agents" is commentator hype — state it precisely:

- **Confirmed (primary):** Claude Code deliberately moved *off* a local vector DB to agentic
  search. Boris Cherny (Claude Code creator, Anthropic): *"Early versions of Claude Code used
  RAG + a local vector db, but we found pretty quickly that agentic search generally works
  better… It is also simpler and doesn't have the same issues around security, privacy,
  staleness, and reliability."* and *"It outperformed everything. By a lot."* (Latent Space,
  2025-05-07; HN item 43164253).
- **Counter-example (do not ignore):** **Cursor invested in custom code embeddings** and reports
  measurable gains (≈12.5% higher answer accuracy; better retention on 1,000+ file repos),
  concluding the best results come from **grep + semantic search combined** (cursor.com/blog/semsearch,
  2025-11-06).
- **Consensus:** the winning pattern is **hybrid** — lexical/symbol search for source code,
  semantic retrieval for large/unstructured corpora (Augment: *"don't throw away your retrieval
  systems — expose them as tools"*, jxnl.co, 2025-09-11). The anti-RAG case is **scoped to
  navigating structured source code**, not document Q&A.

**Implication for OpenLore:** do not pitch a *better index*. The defensible lane is the
**structural / relational** answer that grep is architecturally incapable of giving cheaply —
reverse edges (callers), transitive blast radius, call paths, cross-file/infra dependency
projection — answered in **one** MCP call instead of O(many) grep+read round-trips, and kept
**fresh incrementally** so it never carries the staleness tax Cherny rejected.

---

## The competitive landscape (honest, as-of 2026-05-30)

The pure "local code-graph MCP" lane is **crowded**, and two competitors have far more
traction than OpenLore. Stated plainly so we never pretend otherwise:

| Project | License | Tech | Stars* | Notable |
|---------|---------|------|--------|---------|
| **Serena** (`oraios/serena`) | MIT | **LSP-based** (not tree-sitter) | ~24,800 | Symbolic retrieval + editing; "the IDE for your agent." No published token benchmark. |
| **CodeGraph** (`colbymchenry/codegraph`) | MIT | tree-sitter → SQLite/FTS5 | ~34,000 | ~10 MCP tools (`trace/callers/callees/impact`). **Publishes a WITH-vs-WITHOUT benchmark.** |
| **tokensave** (`aovestdipaperino/tokensave`) | MIT | tree-sitter → libSQL/FTS5 | ~150 | 40+/48 MCP tools; self-reported "93% retrieval savings" (largely on its own repo). |
| **code-graph-mcp** (`sdsrss/...`) | **unverifiable** (no LICENSE file) | tree-sitter | ~37 | Self-reported "5–20× fewer tokens." Low traction. |

\* GitHub API, 2026-05-30; stars move — cite with the as-of date.

**CodeGraph already ships the benchmark we were claiming as our moat.** Its README reports
(median of 4 runs, 7 OSS repos, Claude Opus 4.8 headless, with/without its MCP server):
**"25% cheaper, 57% fewer tokens, 23% faster, 62% fewer tool calls"** (per-repo highs reach
~70% fewer tokens / ~80% fewer tool calls). The "~35% / ~70%" figure seen elsewhere is a
third-party blog tagline / per-repo best, not its headline average — do not misquote it.

**The redundancy risk is therefore the #1 risk, and it lands hardest in the narrow lane.**
If OpenLore ships "another local code-graph MCP," it loses a knife fight on traction and
published evidence. The only escape is to compete where these tools **do not play at all**
(see "Recommended Direction" below) and to publish our own benchmark (see roadmap step 1).

---

## Ground truth — what OpenLore *is*, and what it is *not yet*

This section exists so no future claim outruns the code. All items verified against the repo
on 2026-05-30.

### Confirmed assets (real, citable)

- **Deterministic code graph + fast orient.** `orient()` path (search + 5×callers + callees)
  runs **~429µs p50** on the TypeScript compiler (~15k nodes), per
  [scripts/BENCHMARKS.md](../../scripts/BENCHMARKS.md) (200 iters after warmup) and
  [README.md:206](../../README.md#L206). High trust; repeatable.
- **Typed edges, but only four kinds.** `EdgeKind = 'calls' | 'tested_by' | 'references' |
  'depends_on'` — [src/core/analyzer/call-graph.ts:39](../../src/core/analyzer/call-graph.ts#L39).
  `references`/`depends_on` are produced **only by the IaC parsers**; `tested_by` by test
  detection. **No edge originates from git, PRs, or docs.**
- **Code + infrastructure on one primitive.** The IaC subsystem (terraform/pulumi/k8s/
  cloudformation/cdk/ansible/helm) projects resources onto the *same* `FunctionNode/CallEdge/
  ClassNode` graph — [src/core/analyzer/iac/types.ts](../../src/core/analyzer/iac/types.ts),
  [project.ts](../../src/core/analyzer/iac/project.ts). **This is a genuine differentiator no
  code-only competitor has.**
- **Decision store + spec-drift gate.** Decisions carry SHA-stable 8-char IDs and `affectedFiles`
  ([src/core/decisions/store.ts:123](../../src/core/decisions/store.ts#L123),
  [src/types/index.ts](../../src/types/index.ts)); the `record_decision → consolidate → commit
  gate → spec sync → drift` workflow exists in code. **No navigation competitor ships decision
  governance or a spec-drift gate.**
- **SCIP export** with a correct human-readable string-moniker scheme
  ([src/core/scip/moniker.ts](../../src/core/scip/moniker.ts)).

### What does NOT exist yet (do not claim it)

- **There is no "code↔org join via parsed edges."** Three of the four advertised org artifacts
  are unbuilt: **PRs are never parsed; git is used only for changed-file drift diffing; in-repo
  docs are explicitly *excluded* from drift** ([drift-detector.ts](../../src/core/drift/drift-detector.ts)
  skips `docs/`). The fourth (decisions) is **not a graph join** — `orient` surfaces decisions
  by a plain string set-membership test on `affectedFiles`
  ([orient.ts:367](../../src/core/services/mcp-handlers/orient.ts#L367)), not a traversable edge.
- **SCIP is one-way export only** — [src/cli/export/scip.ts:6](../../src/cli/export/scip.ts#L6)
  says so explicitly. There is no import path. **Do not brand "bidirectional SCIP."**
- **The headline "~1–3k vs 15–50k tokens" claim is unmeasured.** It is a generic assertion in
  [README.md:19](../../README.md#L19), not a benchmark. There is no end-to-end WITH-vs-WITHOUT
  agent-run measurement in the repo; `BENCHMARKS.md` measures raw DB query latency only.
- **No Zed integration exists.** Install targets are Claude Code, Cursor, Cline, Continue,
  AGENTS.md. Earlier drafts' "Zed has no index" anchor was fabricated — drop it.
- **Decision content is LLM-extracted**, so "deterministic" applies to the graph and the
  ID/file addressing, **not** to the decision text.
- **The governance gate is not even active in OpenLore's own repo** (its `.openlore/decisions/`
  is empty). The flagship dogfood project does not yet run its own differentiator.

---

## Recommended Direction

> **OpenLore is the deterministic *analysis layer* for AI coding agents: a local, always-fresh
> graph of the code — and the infrastructure and decisions around it — over which it *computes*
> the facts a model cannot cheaply derive by reading. What breaks if I change this? Which tests
> cover it? What is it coupled to? What rule would this violate? One MCP call, computed not
> guessed. It *complements* agentic search (retrieval); it does not compete with it.**

This is an *evolution* of the existing product, not a replacement. The map (Layer 1) and the
why-layer (Layer 2) remain exactly as they are; the analysis (Layer 3) is computed on top of
them. See "The analysis layer" immediately below for the full framing.

**Why this is the durable bet.** The frontier labs are commoditizing *retrieval* — agentic
search, larger context windows, and smarter models are turning "find the relevant code" into
something the model does for itself. They are **not** building *analysis* (facts computed by
graph algorithms): the model is structurally poor at it, it is expensive to do in-context, and a
free, local, cross-language analysis engine is nobody's business model. The retrieval-MCP cohort
(CodeGraph, Serena, tokensave) also stops at navigation. Analysis is open white space — and it is
exactly what a deterministic graph is *for*.

**Defense against the strongest attack** — the "Cherny killed the index" objection: Anthropic
moved Claude Code off a *semantic RAG embeddings* index, a like-for-like substitution where
lexical grep genuinely won. OpenLore is not a semantic retriever; it computes *relational and
transitive facts* (impact, reachability, test coverage, coupling, invariants) that iterative
grep+read can only reconstruct over many round-trips and many tokens. The staleness tax Cherny
rejected was a *batch re-index*; OpenLore stays fresh incrementally. This survives — but the
public tagline only earns itself once the Spec 14 benchmark proves the savings are real. Build
the layer now; let the numbers earn the claim.

---

## The analysis layer (Layer 3): retrieval vs. analysis

Three layers, nothing removed, each built on the one below:

- **Layer 1 — the map** *(shipping today)*: **structure.** What exists, where execution enters,
  how calls flow. The call/IaC graph, `orient()`, `CODEBASE.md`.
- **Layer 2 — the why** *(shipping today)*: **intent.** Living specs, recorded decisions, drift.
- **Layer 3 — the analysis** *(the evolution)*: **consequences.** Deterministic facts *computed
  over Layers 1–2* that no amount of reading reveals cheaply — what breaks, what to test, what is
  coupled, what is reachable, what rule a change would violate.

**The metaphor.** The agent has **eyes** (grep/read) and a **brain** (the model). The labs are
sharpening both. Nobody is building the **instruments** — the altimeter and radar a pilot
*computes* rather than looks at. OpenLore is the instruments. A smarter brain makes the
instruments *more* valuable, not less — which is precisely why Layer 3 complements the labs
instead of competing with them.

**Layer 3 cannot exist without Layers 1–2,** so the current product becomes the foundation, not
legacy: test selection reads `tested_by` + call edges; reachability is BFS over existing nodes;
co-change reads git; invariants read the dependency graph. Every instrument makes `orient()` more
useful. This is the literal meaning of "grow up and out without deleting anything."

Specs 16–18 are already Layer-3 instruments (decisions made queryable; code↔infra impact;
provenance). The cluster below makes the layer explicit and leads with the clearest demonstration.

### Analysis instruments (the Layer-3 cluster)

Each is deterministic, computed once and cached, reuses the existing graph, and answers a
question grep cannot follow and the model is expensive at — and each stands on established
computer science rather than novelty for its own sake.

| Spec | Instrument | Prior art it stands on | Reuses |
|---|---|---|---|
| **19** | **Deterministic Test Impact Selection** — "you changed X; run exactly these tests" | Regression test selection (Ekstazi; RTS++ call-graph-based) | `tested_by` + call edges (already in the graph) |
| **20** | **Reachability & Dead-Code Analysis** — reachable from any entry point? dead if I delete X? | knip / ts-prune (TS-only); mark-and-sweep from entry points | graph reachability (BFS) |
| **21** | **Structural Change Analysis** — graph-level diff of a change: edges added/removed, stale callers | semantic / AST diff (difftastic) | diff of two graph snapshots |
| **22** | **Change-Coupling & Volatility** — files/functions that always change together; churn hotspots | logical / change coupling (CodeScene) | git history (Spec 18's ingestion) |
| **23** | **Architecture Invariant Guardrails** — "may I import X here?" answered *before* the edit | architecture fitness functions (ArchUnit, dependency-cruiser, import-linter) | dependency graph + Spec 16's decision machinery |

**Backlog (not yet specced — captured so the intent is recorded):**

- **Dependency-upgrade blast radius** — "you are bumping this library; here are the exact
  functions of yours that call the changed APIs." External-dependency tracking × call graph.
- **Coarse source→sink reachability** — "every path that reaches the payments/auth/DB sink." The
  security flavor of reachability; indirect paths grep cannot follow.

These layer on **after** Spec 14 proves the map pays its way. The benchmark is still the gate.

---

## How the org-context dream fits — the honest answer

The owner's original excitement was bringing in **all** context (Jira/Notion/Drive/Gmail via
OAuth) and joining it to code. Here is the truth, sequenced:

- **It is a deferred horizon — closer to a separate product than to core.** The deterministic
  code↔org *join* does not exist today (3 of 4 artifacts unbuilt; decisions are a filter).
- **Cloud OAuth connectors would detonate OpenLore's one verified advantage.** The moment you
  ingest Gmail/Drive/Jira over OAuth, you inherit exactly what Cherny listed as reasons to
  *avoid* an index — security, privacy, staleness, "uploading sensitive context to a third
  party." OpenLore's entire credibility rests on *local, deterministic, no cloud.* Cloud
  connectors trade the moat for a feature Glean and every RAG vendor already sell.
- **So the join enters LOCAL-first, with zero cloud surface:** git history + PR metadata via
  local `gh`/git, and in-repo ADRs/docs as decision sources. That is the "code↔org join" made
  real without OAuth.
- **Cloud OAuth is horizon-3:** opt-in, clearly fire-walled, **never default, never the pitch**,
  and only after the local join is proven and adopted. It may never ship — and that is fine.

The vision is preserved. It is just correctly sequenced behind the things that make OpenLore
defensible first.

---

## The compounding roadmap (benchmark-first, local throughout)

Each step ships on what exists and makes the next cheaper.

1. **Ship the WITH-vs-WITHOUT benchmark first.** Claude Code headless, N≥4 runs, ≥5 OSS repos,
   with/without the MCP server, reporting tokens / tool-calls / cost / wall-clock in a per-repo
   table — mirror CodeGraph's published methodology so it is apples-to-apples. Until it lands,
   **demote the README "~1–3k vs 15–50k" line to a hypothesis.** *Verify:* a reproducible
   `BENCHMARKS.md` end-to-end section. *This step decides which product OpenLore actually is.*
2. **Dogfood the governance.** Turn the gate on in OpenLore's own repo; accumulate real
   decisions; sync them into specs. *Verify:* non-empty decision store + synced spec sections.
3. **Make `Decision` a first-class graph node** with `affects` edges to functions/files,
   traversable by `analyze_impact`/`get_subgraph`. This converts the string-filter weakness into
   the deterministic join we want. *Verify:* `analyze_impact(file)` returns decisions as graph
   neighbors, not a post-hoc filter.
4. **Land the cross-domain impact query** — route → handler → the Terraform/K8s resource that
   deploys it. The IaC subsystem already shares primitives; wire the end-to-end traversal as a
   headline capability. *Verify:* one published code→infra blast-radius example. No grep-agent
   or code-only competitor can do this.
5. **Local org-artifact join — no OAuth.** Parse git blame/history + PR metadata via local
   `gh`/git into `authored_by`/`changed_in_pr` edges; ingest in-repo ADRs as decision sources.
   *Verify:* orient surfaces "who last changed this, in which PR/decision" as graph edges.
6. **Harden distribution on real anchor hosts.** Lead with **Claude Code** (verified: off RAG,
   native grep, no index — the textbook complement). One-command install tested for Claude
   Code + Cursor + Cline. (Only name Zed if/when it is actually wired.)
7. **(Horizon-3, optional, may never ship) Cloud OAuth connectors** as a fire-walled, opt-in
   plugin. Only after 1–5 prove the local join is adopted. The *only* step where cloud enters.

Steps 3–4 are already the first **analysis instruments** (decisions-as-graph, code↔infra impact).
The rest of the Layer-3 cluster — **specs 19–23** (test selection, reachability/dead-code,
structural diff, change-coupling, invariant guardrails) — layers on after step 1's benchmark.
See "The analysis layer" above. The benchmark remains the gate for all of it.

---

## What to explicitly NOT build

- **No semantic/embedding RAG for code navigation.** The graph is relational, not semantic;
  keep it that way. You lose to free built-in grep there.
- **No "bidirectional SCIP" branding.** It is one-way export
  ([src/cli/export/scip.ts:6](../../src/cli/export/scip.ts#L6)). Frame it honestly as "export
  for Sourcegraph/Glean interop." Stop making it a headline noun.
- **No cloud OAuth connectors as a core/default feature.** They detonate the local-deterministic
  moat. Plugin-only, horizon-3, or not at all.
- **No fighting bare code-navigation on traction.** Serena (~24.8k) and CodeGraph (~34k) win
  that fight. Do not pitch "a better grep."
- **No tool-count race.** tokensave ships 48 tools; that is surface area, not a moat. Keep
  `orient` as the frozen single entry verb (the LSP lesson: standardize the thinnest contract).
- **No chat UI, no LLM hosting, no agent loop.** Be the layer others build above.
- **No claiming benchmarks or integrations you have not shipped.** A reviewer falsifies the
  15–50k figure and the Zed claim in 60 seconds, and it taints everything else that is true.

---

## Positioning

> **OpenLore is the deterministic analysis layer beneath your coding agent: one call tells it
> what a change breaks, which tests to run, what's coupled, and what architectural rule it would
> violate — facts *computed* over a local, always-fresh graph, not guessed.**

Local-first. Key-free core. Auditable, deterministic edges. Code *and* infrastructure on one
graph. *(Public tagline gated on the Spec 14 benchmark — build the instruments first, let the
numbers earn the claim.)*

---

## Biggest risk + earliest kill signal

- **Biggest risk: marginal-value collapse.** If, in real agent loops, "a few greps" get close
  enough to one `orient()` call, the freshness/structure tax is not worth it and OpenLore is a
  complement nobody installs — exactly the lane Cherny's data threatens.
- **Earliest kill signal:** the step-1 benchmark comes back showing **<15% token/tool-call
  reduction** vs. plain agentic grep on relational queries (meaningfully worse than CodeGraph's
  published ~25%/~62%). If so, the substrate pitch is dead and the only surviving reason to
  exist is the **governance layer** — at which point pivot hard to "decision-and-drift
  governance for agents" and stop competing as a code graph at all.

**Run the benchmark before writing another line of feature code. It tells you which product you
actually have.**

---

## Relationship to existing specs

- **Spec 04 (SCIP export)** — one-way export for ecosystem interop. Honest framing only.
- **Spec 05 (federation manifest)** — cross-repo self-description ("SBOM of cognition"); the
  natural superset once the single-repo graph is proven.
- **Spec 06 (BM25 without embeddings)** — guarantees deterministic retrieval with zero network;
  the floor any optional semantic layer sits on, never replaces.

---

## Sources & verification provenance

External (primary unless noted):
- Cherny on Claude Code off RAG — Latent Space, *"Claude Code: Anthropic's Agent in Your Terminal,"* 2025-05-07; HN item 43164253.
- Augment / grep vs embeddings — jxnl.co, *"Why Grep Beat Embeddings in Our SWE-Bench Agent,"* 2025-09-11.
- Cursor semantic search — cursor.com/blog/semsearch, 2025-11-06.
- Glean knowledge graph / Onyx — glean.com, github.com/onyx-dot-app/onyx (earlier landscape pass).
- Competitor stars/licenses — GitHub API, 2026-05-30 (point-in-time).
- **Unverified secondary (do not cite as fact):** an Amazon Science paper (~Feb 2026) reportedly
  finding agentic search reaches >90% of RAG performance without a vector DB — not independently
  opened; treat as rumor until the paper is read.

Repo facts: file:line references inline above, verified 2026-05-30.

## Appendix — the reasoning trail

This spec is the durable output of a brainstorming session plus two multi-agent research
workflows (landscape + candidate directions; then verification + adversarial stress-test +
synthesis). The verification pass is what corrected the first draft's overstatements. A future
session can re-run the same shape to re-validate as the market moves.

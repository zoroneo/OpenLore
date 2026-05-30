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
- [ ] **Spec 14** — Agent Token-Efficiency Benchmark Harness (WITH vs WITHOUT). *Do this first.* → [openlore-spec-14-agent-benchmark-harness.md](openlore-spec-14-agent-benchmark-harness.md)
- [ ] **Spec 15** — Decision & Drift Governance Dogfooding (turn the gate on in our own repo). → [openlore-spec-15-governance-dogfooding.md](openlore-spec-15-governance-dogfooding.md)
- [ ] **Spec 16** — Architectural Decisions as First-Class Graph Nodes (`affects` edges). → [openlore-spec-16-decisions-as-graph-nodes.md](openlore-spec-16-decisions-as-graph-nodes.md)
- [ ] **Spec 17** — Cross-Domain Impact Analysis (Code ↔ Infrastructure). → [openlore-spec-17-cross-domain-impact.md](openlore-spec-17-cross-domain-impact.md)
- [ ] **Spec 18** — Local Provenance Edges (Git & PR metadata, no OAuth). → [openlore-spec-18-local-provenance-edges.md](openlore-spec-18-local-provenance-edges.md)
- [ ] **Horizon 3 (optional, may never ship)** — cloud OAuth connectors as a fire-walled plugin. Deliberately *not* a numbered spec until 14–18 land and prove the local-first thesis.

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

## How the shape of the product changes

This is growth along the axis OpenLore already chose, not a turn onto a new one:

| | Today | After specs 14–18 (still local, still key-free, still coding-first) |
|---|---|---|
| **Core artifact** | Deterministic code call graph | Same graph, now spanning code **+ infrastructure + decisions** on one primitive |
| **What `orient()` answers** | who-calls / what-breaks / call-path / insertion points / spec matches | + code→infra blast radius; + "who last changed this, under which PR/decision" |
| **Decisions** | LLM-extracted, stored in a side-file, surfaced by a string filter | First-class graph nodes with `affects` edges, traversable by `analyze_impact` |
| **Evidence** | "saves 15–50k tokens" (unmeasured claim) | A reproducible WITH-vs-WITHOUT benchmark, published |
| **Audience** | Coding agents | **Unchanged** — coding agents |
| **Network** | Optional (specs/LLM only) | **Unchanged** — core stays offline; cloud is opt-in Horizon-3 only |

The product goes from *"a map of your code"* to *"the always-fresh structural and governance
memory of your code, the infra it deploys to, and the decisions that shaped it"* — a wider view
of **the same developer's world**, for **the same audience**, with **the same local-first,
deterministic guarantees**. That is "grow up and out," not pivot.

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
  docs are explicitly *excluded* from drift** ([drift-detector.ts](../../src/core/services/drift-detector.ts)
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

> **OpenLore is the always-fresh, deterministic *structural substrate beneath* agentic search —
> it answers who-calls / what-breaks / call-path in one sub-millisecond MCP call against a typed
> code graph that also spans infrastructure, and it uniquely pairs that graph with a governance
> layer (recorded decisions + a spec-drift gate) that no navigation competitor ships.**

The substrate is the **credibility proof**, not the pitch. The pitch is the two things the
crowded cohort does not have: **cross-domain (code↔infra) impact** and **decision/drift
governance coupled to the graph.**

**Defense against the strongest attack** — the marginal-value / "Cherny killed the index"
objection: Anthropic moved Claude Code off a *semantic RAG embeddings* index, a like-for-like
substitution where lexical grep genuinely won. OpenLore is not a semantic retriever; it is a
**typed relational graph** answering reverse-edge and transitive-impact queries that iterative
grep+read can only reconstruct through many round-trips. The staleness tax Cherny rejected was a
*batch re-index*; OpenLore answers it with **incremental** watcher updates, so the staleness
surface is small. This survives — but only once the benchmark (step 1) proves the round-trip
savings are real. Until then it is a hypothesis, not a result.

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

> **OpenLore is the always-fresh code graph beneath your agent: one `orient()` call gives
> who-calls, what-breaks, and call-path that grep would burn 20 round-trips to rebuild — plus
> the only decision-and-drift governance layer that travels with the code.**

Local-first. Token-scoped. Auditable edges. Code *and* infrastructure on one graph.

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

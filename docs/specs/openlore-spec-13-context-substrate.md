# OpenLore Spec 13 — The Context Substrate (True North)

> This is a **strategy + architecture** spec, not a single-PR prompt. It defines the
> direction every subsequent spec should serve, and seeds the concrete next specs
> (14+) that implement it incrementally. Read it before proposing any large feature.

---

## Progress

Branch: `openlore-spec-13-context-substrate`. Vision locked; roadmap defined; implementation specs to follow.

- [x] Strategic direction chosen by owner (2026-05-29): **substrate/plumbing**, not breadth-product
- [x] Competitive landscape mapped (Glean, Onyx, MCP connector zoo, coding-context maps, protocol precedents)
- [x] Core thesis stated and stress-tested: the *deterministic substrate* bet
- [x] Compounding roadmap defined (git/co-change → forge → tracker → docs → comms → semantic)
- [x] Scope discipline written (what OpenLore must NEVER become)
- [ ] `TODO(spec-14)`: Git / co-change layer — no OAuth, no LLM, ships to every coding agent
- [ ] `TODO(spec-15)`: Connector write-contract v1 — the ~50-line plugin shape
- [ ] `TODO(spec-16)`: Cross-source deterministic resolver (ID/URL/email join)
- [ ] `TODO(spec-17)`: `orient()` over the merged graph — token-budgeted subgraph response
- [ ] `TODO(future)`: Forge / tracker / docs / comms connectors (each rides existing MCP servers)

---

## Context for you (the agent / the maintainer)

OpenLore today is a **deterministic, local-first, token-cheap context engine for code**:
tree-sitter call graph + clusters + McCabe (no API key), an optional LLM spec/decision
layer, and a 45-tool MCP runtime fronted by `orient()`. Its measured value is replacing
15,000–50,000 tokens of file-by-file rediscovery with a ~1–3k targeted orientation pass.

The question this spec answers: **what does OpenLore become next, and what does it
refuse to become?**

The space is crowded and well-funded:

- **Glean** — enterprise knowledge graph; the real moat is **real-time ACL mirroring**
  across 100+ connectors, sold to IT. That mirroring is both its moat and its tarpit.
- **Onyx (ex-Danswer)** — the OSS Glean: MIT, self-hostable, 40+ connectors, hybrid
  vector+keyword RAG. But it is a **chat-over-your-docs product**, not an agent context layer.
- **The MCP connector zoo** — Atlassian (official), Notion (official), Google Workspace,
  Gmail. OAuth + fetching is **already solved**. But these are **dumb pipes**: query-time
  tools that dump raw pages into the agent's context. Nobody *structures across them*.
- **Coding-context maps** — Cursor's index, Sourcegraph (Cody/Amp + **SCIP/LSIF**),
  Augment, Continue, Aider's repo-map. Most are embeddings-over-text or closed/cloud.
- **Protocol precedents** — **tree-sitter, LSP, SCIP, LSIF, Kythe, GraphRAG.** The
  durable winners in this space won by being a **contract**, not an app.

### The decision

> **OpenLore is plumbing, not a product.** Its job is to be the deterministic context
> *substrate* that any agent or tool builds on — the "tree-sitter / SCIP for agent
> context" — not a Glean-style breadth product with 40 connectors and a chat UI.

This single decision cascades and resolves two otherwise-hard forks for free:

1. **Whose permissions?** → Substrate + local-first ⟹ **token-scoped, not org-wide.**
   The agent sees what *your* OAuth token sees. No ACL-mirroring engine to build, no
   security-review nightmare to own. We deliberately cede Glean's enterprise-ACL moat
   because it is also its tarpit; our user is the *developer and their agent*, not IT.
2. **Build connectors or ride MCP?** → Substrate ⟹ **ride the existing MCP connectors.**
   Official Atlassian/Notion/Google MCP servers already solved OAuth + fetch. OpenLore
   sits **above** them as the layer that builds the deterministic, cross-joined graph.
   We do not re-implement OAuth twelve times. We do not enter the connector graveyard.

---

## The core thesis (the load-bearing bet)

> **There is a large DETERMINISTIC substrate inside org data that competitors needlessly
> pay an LLM / embeddings to rediscover.**

Glean and Onyx treat everything as text → embed → retrieve. But an enormous amount of
structure is **explicitly stated** and needs no inference:

| Source | Deterministic structure (no LLM) |
|--------|----------------------------------|
| Jira / Linear | epics→stories→subtasks, blocks/blocked-by, assignees, sprints, status transitions |
| Confluence / Notion | page trees, backlinks, @mentions, spaces |
| Google Drive | folder tree, sharing/ownership edges, doc-to-doc links |
| Gmail / Slack | thread structure (`References`/`In-Reply-To`), sender/recipient graph |
| GitHub / forge | PR ↔ issue ↔ commit ↔ file, reviews, cross-refs |
| Code (today) | call graph, imports, clusters — already OpenLore's core |

And the gold nobody mines: **these systems cross-reference each other.** A Jira ticket
pastes a Confluence URL that links a Google Doc implemented in a GitHub PR discussed in
an email thread. **Every one of those edges is a deterministic join on an ID, URL, or
email address** — no embeddings, no hallucinated relationships, fully auditable, offline.

This is *exactly* OpenLore's existing philosophy (Layer 1 = deterministic; Layers 2/3 =
optional semantic) applied to the org instead of the repo. Embeddings are reserved only
for the genuinely fuzzy edge — "these two docs are *about* the same thing even though
neither links the other" — which becomes an **optional** layer on top, same as for code.

### The unique unlock — the join no competitor has

OpenLore already owns the **code graph**. Glean and Onyx index code as *text*; they are
blind to call topology. Coding-context maps own the code graph but have no org context.
**Nobody joins the two.** Wire the call graph into the org graph in one structure and you
get an edge chain that is genuine white space:

```
function exportToCsv()
   → implements   → JIRA-412
   → specced-in   → Confluence "Export v2"
   → designed-in  → Drive design doc
   → discussed-in → email thread
```

When an agent says *"implement OAuth for the export feature,"* one `orient()` call returns
that whole subgraph — ranked, with ~200-token summaries and stable IDs — instead of six
MCP calls dumping 50k tokens of raw pages. The agent then lazy-fetches only the one or two
leaves it actually needs. **That is the token-saving, context-management story, and it is
just `orient()` extended past the repo boundary.**

---

## What "be plumbing" actually means

The precedent to copy is **tree-sitter / SCIP / LSP**: adopted because they are a
*contract*, not an app. OpenLore-the-binary becomes the **reference implementation** of a
contract that others can emit into, query, or reimplement. Three things must be nailed:

### 1. The format (the actual deliverable)

A versioned, **on-disk, git-diffable** node/edge schema with **provenance**. Deterministic
means inspectable: you can `cat` the graph and see exactly *why* an edge exists — which URL,
which ID, which commit produced it. No black-box embedding silently deciding a relationship.

This already has seeds in-repo: **Spec 04 (SCIP export)** makes the code graph consumable by
the SCIP/Glean ecosystem; **Spec 05 (federation manifest, `.well-known/openlore.json`)** is
the "SBOM-of-cognition" self-description. Spec 13 generalizes these: the context graph is the
union of code symbols + org nodes + the deterministic edges between them, persisted locally.

Minimal node/edge contract (v1 sketch — to be pinned in Spec 15/16):

```jsonc
// Node — anything addressable across any source
{
  "id": "openlore://github/clay-good/openlore/pr/95",  // stable, source-qualified URI
  "type": "pull_request",          // function | file | issue | doc | page | email | person | commit | pr ...
  "source": "github",
  "title": "fix: quiet install re-runs",
  "ts": "2026-05-28T14:02:00Z",
  "perms": "token-scoped",         // visible because YOUR token saw it; no ACL mirror
  "summary": null                  // optional, lazily filled; NOT raw content
}

// Edge — every edge carries provenance so it is auditable
{
  "from": "openlore://github/.../pr/95",
  "to":   "openlore://jira/PROJ/issue/412",
  "type": "references",            // implements | references | mentions | parent_of | authored_by | co_changes_with | specced_in ...
  "deterministic": true,
  "provenance": { "kind": "url_in_body", "evidence": "https://.../browse/PROJ-412" }
}
```

### 2. The read interface

`orient()` over MCP — already shipped for code; extended to traverse the merged graph.
"Go-to-definition" for *context*. Stable verb, agent-agnostic.

### 3. The write contract

A connector so small (~50 lines: "emit these nodes, these edges") that the community
actually writes them. Heaviness is what killed prior connector ecosystems. Where possible,
a connector is a **thin adapter over an existing MCP server**, not a fresh OAuth client.

---

## The compounding roadmap (the part that adds up)

Every new source is the **same move**: ingest → extract its native deterministic graph →
join to the existing graph on shared IDs/URLs/emails. Each join makes *every prior source
more valuable*, because edges compose into multi-hop chains. Sequenced cheapest-and-highest-
trust first:

1. **Git / co-change layer — `TODO(spec-14)`.** *No OAuth, no LLM, already local.* Blame,
   history, and the killer signal AST cannot see: **co-change edges** ("these files/functions
   change together"). Bridges code → people → intent before touching a single connector.
   Ships value to **every** coding agent on day one. **This is the wedge.**
2. **Forge layer (your token).** PR ↔ issue ↔ commit ↔ file ↔ review. Explicit links =
   deterministic. Code gets its first layer of *why*. Reuses Spec 04/05 plumbing.
3. **Tracker layer (Jira / Linear via MCP).** Issue/epic graph + its explicit PR links.
   code → PR → issue → epic.
4. **Docs layer (Confluence / Notion / Drive via MCP).** Page trees, backlinks, and the
   cross-source URLs that link docs to issues. The cross-source join lights up here.
5. **Comms layer (Gmail / Slack).** Thread graph + the URLs inside messages. The
   "discussed-in" edges that close the loop back to code.
6. **Semantic layer (optional, last).** Embeddings *only* for the fuzzy "about the same
   thing" edges the deterministic layers cannot produce. Exactly today's Layer-1/Layer-2 split.

By step 5, a single `orient()` traverses `function → PR → issue → doc → email` in one chain
no competitor can produce — reached by adding edge *types* to one graph, never rebuilding.

### Cross-cutting concerns each step inherits

- **Identity resolution.** Stitch "Clay in Jira" = "clay-good on GitHub" = "hi@claygood.com"
  deterministically on email/handle where possible; a small fuzzy layer only for the residual.
  Persisted as `person` nodes with `same_as` edges carrying provenance.
- **Freshness.** Today's file-watcher does incremental code sync. The analog is webhook/delta
  pull per source. Real-time is *not* required for v1 — a manual/periodic refresh is fine; the
  graph records `ts` so staleness is visible. Do not over-build sync before the graph is proven.
- **Token-scoped permissions.** No ACL mirror. Every node is in the graph because *your* token
  fetched it. This is a feature (zero security engine), documented as an explicit non-goal of
  enterprise multi-tenant indexing.

---

## Scope contract — what OpenLore must NEVER become

To stay plumbing and not drift into a product:

- **No chat UI.** We do not answer questions; we serve a graph the agent reasons over.
- **No LLM hosting / no embedding service.** Semantic layer is optional and BYO (see Spec 06,
  BM25-without-embeddings — deterministic retrieval must always work with zero network).
- **No org-wide ACL mirroring / multi-tenant index.** Token-scoped only. Ceded to Glean on purpose.
- **No re-implementing OAuth per service.** Ride existing MCP connectors; thin adapters only.
- **No mirroring of raw content.** Store the **graph** (IDs, links, titles, small summaries,
  provenance) and **lazy-fetch** content on demand. Token savings come from never pulling a full
  doc until the agent picks it.
- **No required network, ever, for the deterministic core.** Offline-first is identity, not a feature.

The test, inherited from the project's surgical-change ethos: **every feature must make the
graph more queryable or more deterministic. If it adds a surface the agent talks *to* instead
of a graph the agent reasons *over*, it does not belong in OpenLore.**

---

## Positioning

> **OpenLore: the deterministic context graph for AI agents — tree-sitter for your org,
> not just your code.**

Local-first. Token-cheap. Auditable edges. Rides the MCP ecosystem it sits above.

---

## Risks and kill signals

| Risk | Earliest signal the bet is wrong |
|------|----------------------------------|
| **Redundancy with coding-context maps** (Cursor/SCIP/Augment already "good enough") | Spec 14 (co-change) lands and no agent workflow measurably improves over plain file reads |
| **Deterministic substrate is too thin** — the useful edges turn out to need LLM inference after all | In the forge/tracker layers, >50% of valuable edges require fuzzy matching, not ID/URL joins |
| **Connector contract too heavy** — community doesn't write connectors | After Spec 15, no external contributor ships a connector in <1 day |
| **MCP servers can't bulk-crawl** — query-time tools won't enumerate for graph construction | Tracker/docs layers stall because official MCP servers expose no listing; forces direct-API fallback (raises maintenance back toward connector-graveyard levels) |
| **No distribution** — substrate with no consumers | After 6 months, OpenLore is not the default context layer under any agent it didn't ship itself |

The single biggest risk is **redundancy**: if the coding-context incumbents are already
good enough that the *deterministic + cross-domain join* doesn't change agent outcomes, the
substrate has no reason to exist. The co-change layer (Spec 14) is deliberately first because
it is the cheapest possible test of that risk — it needs no auth, no LLM, and either visibly
improves orientation or it doesn't.

---

## Relationship to existing specs

- **Spec 04 (SCIP export)** — interop format; the code half of the substrate, already shippable.
- **Spec 05 (federation manifest)** — cross-repo self-description; the "SBOM of cognition." The
  context graph is the natural superset (org nodes + cross-source edges added to the same idea).
- **Spec 06 (BM25 without embeddings)** — guarantees deterministic retrieval with zero network;
  the floor the semantic layer sits on top of, never replaces.

Specs 14–17 (git/co-change, connector contract, cross-source resolver, merged `orient()`) are
the concrete first implementations of this true north and should be written next.

---

## Appendix — the reasoning trail (brainstorm of 2026-05-29)

This spec is the durable output of a brainstorming session. The reasoning, the rejected
alternatives, and the multi-agent stress-test synthesis are appended below so a future
session can re-derive *why* without repeating the exploration.

> The multi-agent "true north" workflow synthesis is appended in a follow-up commit to this
> same PR (research of coding-context-map competitors, protocol-precedent lessons, adversarial
> stress-tests of the three core theses, and the judged candidate true-norths).

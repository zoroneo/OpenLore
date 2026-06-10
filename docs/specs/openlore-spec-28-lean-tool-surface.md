# OpenLore Spec 28 — Lean / Deferred MCP Tool Surface (close spec-25 §7's "biggest upside")

> Closes the one open question Spec 25 §7 flagged as **"biggest unknown, biggest upside"**: *can MCP
> tool schemas be deferred/lazy the way this runtime defers its own tools?* If yes, the ~11.8k-token
> `tools/list` prefix — part of the structural shallow-task cost Spec 27 proved it could not remove —
> might vanish. This spec measures the answer instead of guessing it, ships the deterministic
> server-side win, and reports the limit honestly. Parent: [Spec 25](openlore-spec-25-token-value-optimization-and-proof.md)
> (§7). Sibling: [Spec 27](openlore-spec-27-lean-adaptive-orientation.md) (the lean *orient* payload).

---

## Progress

Branch: `feat/spec-28-lean-tool-surface`. Same honesty contract as Spec 25 applies — the number we
publish is the number we measured, including a win that turns out small.

- [x] **P1 — Lossless tool-surface trim.** The `directory` input is shared by all 50 tools and carried
  a verbatim 38-char description on each; collapsed to one short shared constant (`DIR_DESC`, 21 chars).
  Dropped three pure capability-boast clauses that carry **no tool-selection signal** ("faster than
  reading package.json + directory tree yourself", a redundant language list, "No LLM calls required"
  — the local-vs-LLM distinction is already in the `openWorldHint` annotation). Measured on this repo:
  full `tools/list` **47,037 → 46,118 bytes (−2.0%, ~229 tokens)**; navigation preset **8,121 → 8,002
  (−1.5%)**. **Zero selection-quality risk** — no disambiguating description text was touched. Unit-tested.
- [x] **P1 — Payload-size regression guard.** New `tools/list payload budget (spec-28)` tests bound the
  full surface (<48 KB) and the navigation preset (<8.5 KB), plus a lossless-dedup invariant (the shared
  `directory` description stays ≤25 chars and is reused by ≥80% of tools). A new tool (~900 B) or
  re-bloated boilerplate now fails the suite — adding to the cached prefix is a conscious budget bump,
  not silent drift. This is the durable deliverable; the −2% trim is the one-time cleanup.
- [x] **P2 — Answered the §7 question, by measurement (the headline, honest finding).** MCP has **no
  server-driven lazy-schema mechanism**: `tools/list` returns every tool's full `inputSchema`, and the
  server can't advertise names-only and defer schemas. **But the dominant client (Claude Code) already
  defers MCP tool schemas *client-side*** — verified live this session: OpenLore's tools arrive as names
  with schemas loaded on demand, so the ~11.5k-token prefix is **not paid up front** in that client at
  all. So §7's "biggest upside" is **real but client-controlled**: where it matters most it is already
  captured, and the server cannot do better than the client already does. For *eager* clients (Cline,
  older runtimes) the server's only levers are tool **count** (presets, Spec 14/25) and schema **bytes**
  — and the lossless byte-lever is only ~2%, because the payload is dominated by irreducible per-tool
  schema structure plus the selection text an agent genuinely needs to pick the right tool.
- [ ] **P3 — Meta-dispatcher tool (DEFERRED — explored, deliberately NOT implemented).** Collapsing the rarely-used long tail
  (inventories, reports) behind a single `openlore(action, …)` tool would shrink the eager-client
  surface further, but it **trades the wrong way**: it discards per-tool schema validation, the
  read/write/open-world annotations (Spec 11), and the discoverable surface an agent selects from —
  re-introducing exactly the wrong-tool round-trips Spec 25 §7 warned compaction can cause. We do not
  ship it. Forcing `navigation` as the install **default** was re-litigated and again rejected (Spec 25
  Phase B): it hides the governance tools the decision gate needs. Opt-in presets remain the answer.

**Net (honest):** the structural `tools/list` prefix cost is **client-side**, and the dominant client
already erases it by deferring schemas — so Spec 25 §7's biggest upside is largely already realized
where it counts, not by anything OpenLore ships. Server-side, the surface is now provably lean (a
lossless ~2% trim) and **bounded against future bloat** (the budget guard). We ship the safe win and
the lasting guard, and report that the headline lever was never the server's to pull.

---

## 1. The measured problem (Spec 25 §3 / §7)

The full OpenLore tool surface is **50 tools / ~47,037 bytes / ~11,759 tokens** of `tools/list`. For an
MCP client that loads all tool schemas eagerly, that prefix is re-sent (or, at best, cached) **every
turn**, before any `orient` call — a fixed tax that, on a trivial lookup in a small repo, can exceed
the whole answer (Spec 27 §1). Spec 25 §7 named the one lever that might erase it outright — *deferring
the schemas the way this runtime defers its own tools* — and left it open as "biggest unknown, biggest
upside." This spec resolves it.

Composition of the payload (why the byte-lever is small):

| part | share | reducible losslessly? |
|---|---|---|
| per-tool `inputSchema` structure (types, enums, required, property names) | ~46% | no — MCP requires it per tool |
| tool + property **descriptions** | ~38% | partly — only non-selection text (boasts, repeats) |
| `name` + `annotations` (Spec 11 hints) | ~16% | no — correctness/selection signal |

Only the redundant slice of the description budget is safe to cut. The `directory` description (50×
identical) and a few capability-boast clauses are that slice; everything else is either schema the
protocol mandates or signal an agent uses to choose a tool.

## 2. Mechanism — lossless trim + a budget guard (P1)

- **Shared short `directory` description.** One `DIR_DESC` constant (`'Absolute project path'`) replaces
  the 38-char verbatim repeat on all 50 tools. Keeps the only fact that matters (it must be absolute),
  drops the rest. Lossless of selection signal.
- **Drop pure boasts.** Three clauses that an agent never uses to pick between tools are removed; the
  `openWorldHint` annotation already encodes local-vs-LLM, so "No LLM calls required" was pure repetition.
- **Budget guard.** Tests bound full (<48 KB) and navigation (<8.5 KB) payloads and pin the dedup
  invariant. The surface can grow only by a deliberate ceiling bump — the cached prefix cannot creep.

These compose with Spec 25 (cache-stable prefix) and Spec 14/25 presets: the trim shrinks bytes for
eager clients, the guard keeps them shrunk, and deferring clients (§3) pay none of it up front anyway.

## 3. The honest finding — lazy schemas are the client's job, and the main client does it

Two facts, both verified rather than assumed:

1. **The MCP protocol has no server-side schema deferral.** `tools/list` returns each tool's complete
   `inputSchema`; there is no "advertise names, fetch schema on use" handshake a server can drive.
2. **Claude Code defers MCP tool schemas client-side.** This very session received OpenLore's tools as
   names with schemas loaded on demand — so in the dominant client the ~11.5k-token prefix is not loaded
   up front. The upside Spec 25 §7 hoped for is therefore **already captured, by the client**, and is
   outside OpenLore's control to improve.

Conclusion: the structural prefix cost Spec 27 measured is real for *eager* clients and ~zero for
*deferring* ones; OpenLore cannot move the deferring case (the client already won it) and can move the
eager case by only ~2% losslessly (the rest is irreducible). The honest lever for the eager case stays
**tool count** — the opt-in `--preset navigation` (−83% of the surface), recommended but not forced.

## 4. Non-goals

- Not lossy: no disambiguating tool/property description is paraphrased or dropped — only verbatim
  repeats and non-selection boasts.
- Not a meta-dispatcher: collapsing tools behind one action tool trades away validation, annotations,
  and discoverability for bytes (P3) — net negative.
- Not a new default surface: the full set stays the default; `navigation`/`minimal` stay opt-in (Spec 25).
- Not a claim that this erases the shallow-task loss: §3 shows the only lever that could is client-side
  and already pulled.

## 5. Success criteria

- ✅ `tools/list` is materially smaller losslessly (full −2.0%, nav −1.5% on this repo) with no
  selection text removed — unit-tested.
- ✅ A regression guard bounds the surface so the cached prefix cannot silently bloat — adding a tool
  requires a conscious budget bump.
- ✅ Spec 25 §7's open question is **closed with a measured answer**, not left open: server-side schema
  deferral does not exist in MCP; client-side deferral exists and the dominant client uses it; the
  server-side byte-lever is ~2%. Reported plainly, including that the headline upside was never ours.

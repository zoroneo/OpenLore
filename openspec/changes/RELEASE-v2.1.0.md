# Release v2.1.0 (from v2.0.19)

Memory-quality + onboarding release. All changes are **additive and backward-compatible** — no breaking
changes to tools, schemas, or stored data; callers that ignore the new fields/params see prior behavior.

Shipped on PR #161. Staged by a `chore(release)` bump of `package.json` + `package-lock.json` to
`2.1.0`; the release workflow's tag↔version guard (`.github/workflows/release.yml`) then validates the
`v2.1.0` tag, runs lint/typecheck/tests, publishes to npm with provenance, and updates the Homebrew
formula post-publish.

## What's new

### 1. Deterministic recall ranking — `improve-recall-retrieval-ranking`
`recall` no longer ranks by binary substring token-overlap (which silently dropped relevant memories on
a phrasing mismatch). New pure, deterministic ranker: identifier-aware normalization
(camel/Pascal/snake/kebab), field weighting (anchor symbol > tag > anchor file > content), graded
scoring, an exact-anchor boost, and a substring fallback that guarantees a superset of prior matches.
No LLM, no embeddings. Each result can report why it ranked (`match { fields, anchorBoost }`).

### 2. Trust-calibrated context economy — `add-trust-calibrated-context-economy`
A `fresh` recalled fact now carries a **grounding certificate** `{symbol, filePath, lineSpan,
contentHash}` and a **`verifiedCurrent`** marker — proof the span is unchanged since analysis, so the
agent can cite it instead of re-reading. `recall` gains an optional **`tokenBudget`** that returns the
highest grounding-density facts first and reports a `budget {tokenBudget, returned, withheld}` block —
never a silent cap. Drifted/orphaned facts never carry certificates (the authoritative-recall invariant
holds).

### 3. `openlore connect` onboarding — `add-agent-onboarding-connect`
Discoverable one-command agent onboarding built by **enhancing the existing install engine** (no
duplicated wiring): `openlore connect [agent] | list | remove`, an interactive multi-select, a
`--preset` flag threaded into the registered MCP server, `Bash(openlore:*)` permission wiring
(idempotent + reversible), and a preset-insensitive `connect list` status.

## Verification

- **Tests:** recall ranking 15 unit + 6 e2e; trust-calibrated +5 e2e; connect 10 unit/e2e; existing
  install suite unchanged. Full `vitest run src`: **185 files, 3863 passed / 2 skipped / 0 failed**.
  `typecheck` + `eslint` clean. The spec-28 MCP tool-manifest char-budget guard is respected
  (tools/list ≈ 54.9k chars, under 55k).
- **Real-input dogfood** (see `DOGFOOD-v2.0.19.md`): exercised via the real built CLI and the real MCP
  server over stdio JSON-RPC against clean `git init` repos and this repo's graph — full `connect`
  lifecycle (incl. first-run index build, idempotency, preset, existing-file injection, invalid-preset
  exit 2, removal) and `remember`/`recall` (ranking order, symbol + file-anchor certificates with real
  line spans, drifted gating, budget truncation). `tools/list` confirmed to advertise the new
  `tokenBudget` param. **0 functional bugs found.**

## Decisions recorded + synced

- `08005eb9` — deterministic field-weighted recall ranker.
- `61c2ea7d` — grounding certificates + verified-current + grounding-density budget tiering.
- agent-connect design (enhance install + thin front-end), documented in its proposal.

## Notable non-goals / deferred (documented in the proposals)

Embedding-backed recall; salience-label budget ordering; `bench:agent` token-delta measurement; broader
connect agent matrix; lean default tool preset; the full `add-bitemporal-typed-memory-operations` change
(paused — not in this release). One pre-existing cosmetic note: `connect remove` leaves now-empty config
dirs (predates this PR).

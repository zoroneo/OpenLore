# OpenLore Spec 13.1 — Make Incremental Freshness Cheap (Watch-Mode Performance)

> **Type:** urgent regression fix, not a feature. This is a child of [Spec 13](openlore-spec-13-context-substrate.md):
> Spec 13 promises OpenLore "stays fresh **incrementally** so it never carries the staleness tax
> Cherny rejected." The watcher is that mechanism — and today it imposes *its own* tax. This spec
> makes incremental freshness actually O(change), so `--watch-auto` can stay **on by default**
> (owner's decision, 2026-05-31) without degrading the agent session that depends on it.
>
> **Do this before Spec 14.** It is a live dogfooding-blocker (see "Why this jumps the queue").

---

## Progress

Branch: `openlore-spec-13.1-watch-mode-performance` (proposed). Root cause confirmed against the code.

- [x] Symptom reproduced from the field: multiple Claude Code sessions across multiple dogfooded
      repos report *"severe, batched result-delivery latency — commands ran correctly on disk and
      on the remote, but their output came back in large delayed drains."* Only began once the
      `openlore` MCP server was registered in those repos.
- [x] Root cause traced to the watch-mode re-index pipeline (this document, "Root cause").
- [x] **Step 1** — Coalesce per-file events into a single batched flush (one write per burst).
      `McpWatcher` now uses one `pending` Set + a single debounce timer + a `maxBatchMs`
      ceiling; `handleChange(path)` delegates to `handleBatch([path])`.
- [x] **Step 2** — Make the `llm-context.json` update cheap and stop busting the read cache.
      Implemented 2a: `primeContextCache` (new export in `mcp-handlers/utils.ts`) hands the
      patched context to the read cache so the next tool call is a HIT (in-memory) instead of a
      full cold re-parse of the multi-MB artifact. The watcher loads its base from disk *ground
      truth* (never the shared cache) so it can't patch a stale object and drop signatures a
      concurrent `analyze` wrote; it then primes the cache with the result. The per-burst disk
      write is already coalesced by Step 1 (one flush per batch), so an explicit write-behind
      timer was dropped as needless crash-risk for negligible gain.
- [x] **Step 3** — Make the vector-index update a real incremental row op (no full-table rewrite).
      New `VectorIndex.updateFiles()` does a row-level ``delete(`filePath` IN …) + add(rows)`` for
      the changed files only and patches the BM25 corpus cache in place; the cold `build()` path is
      untouched. **Caught in E2E testing:** the predicate column MUST be backtick-quoted —
      LanceDB's datafusion parses a *double-quoted* identifier as a string literal, so
      `"filePath" IN (…)` silently matches nothing and deletes no rows (a no-op that would have
      shipped stale duplicates into the index). Guarded by `vector-index-updatefiles.test.ts`.
- [x] **Step 4** — Decouple embedding freshness from signature freshness (signatures land instantly).
      Signatures persist synchronously first; the vector update runs on a separate lower-priority
      embed lane. Added `--watch-no-embed` + auto-degrade above `WATCH_EMBED_FILE_CEILING` (5000).
- [x] **Step 5** — Backpressure + VCS-flood detection (branch switch ⟹ one refresh, not N).
      A `.git` ref watcher (HEAD/index/MERGE_HEAD/ORIG_HEAD) + a `WATCH_BULK_THRESHOLD` (25)
      batch-size trip collapse a bulk event into one settled refresh; single-flight never interleaves.
- [x] **Step 6** — stderr discipline (one summary line per batch; verbose behind a debug flag).
      Default is one `[mcp-watcher] updated/coalesced N … (Mms)` line per batch; per-file/per-embed
      detail is behind `OPENLORE_WATCH_DEBUG`.
- [x] **Step 7** — Reconcile docs/install text with the on-by-default reality.
      `docs/mcp-tools.md`, `README.md`, `src/cli/install/index.ts`, and the orient skill wrapper
      now state watch is on by default, cheap/batched, and how to disable / run signatures-only.
- [x] **Step 8** — Watch-mode microbenchmark + regression tests.
      `scripts/bench-watch.ts` (+ `npm run bench:watch`, recorded in `scripts/BENCHMARKS.md`) plus
      `mcp-watcher-incremental.test.ts` and `vector-index-updatefiles.test.ts`.
- [x] **E2E field-config reproduction** (`scripts/e2e-watch-latency.mjs`, `npm run e2e:watch`).
      Spawns the **built** `openlore mcp` server with **no flags** (the exact field config — so
      `--watch-auto` arms on the first tool call) against a real analyzed repo (the openlore repo
      itself: 4.6 MB `llm-context.json`, 4.3 MB call-graph.db, BM25 vector index), fires a 30-file
      save burst, and measures tool-call round-trip latency *during the re-index window* + total
      watcher stderr. Run against PRE-FIX (`0368d90`) vs FIXED (`0b6d188`):

      | Metric | PRE-FIX | FIXED |
      |---|---|---|
      | Post-burst tool latency (max) | **1190 ms** | **3 ms** |
      | Post-burst tool latency (median) | 2 ms | 1 ms |
      | Watcher stderr lines (whole run) | **206** | 16 (1 from watcher) |
      | Just-saved symbol visible to `search_code` | yes | yes |

      The PRE-FIX **1.19 s blocking tool call** during the storm is the field's "batched
      result-delivery latency" reproduced and measured; the fix collapses it to 3 ms and removes
      the 206-line stderr flood. The before/after also proves the harness can detect the
      regression — a green-only result would be meaningless without it.

**Measured (`npm run bench:watch`, synthetic 4.03 MB context, signatures-only):** single-save
flush **4.5 ms**; next-call read after save **0.02 ms** (in-memory cache HIT) vs **4.4 ms** cold
parse (≈256× on this fixture, widening with context size); 50-file burst → **1** flush (was 50
full pipelines), coalesced flush **8 ms**. The decisive wins are the eliminated forced re-parse
(G1) and the single-flush coalescing (G2). Satisfies G1, G2, G3, G4, G5, G6; G7 protected (cold
`build()`/`analyze` paths untouched; full unit + relevant integration suites green).

> **Not** addressed by PR #83 (Panic Response Layer). PR #83 touches `mcp.ts` and `vector-index.ts`
> for panic/gryph concerns only; it does not change the `mcp-watcher` re-index pipeline,
> `handleChange`, or `--watch-auto`. The two are independent — both edit `mcp.ts` but in different
> regions, so expect a small merge but no logical conflict. **PR #83 does not fix this.**

---

## Symptom (from the field)

Reported verbatim by multiple agent sessions, across multiple repos, only after dogfooding began:

> "The tool-execution environment in this session had severe, batched result-delivery latency —
> commands ran correctly on disk and on the remote, but their output came back to me in large
> delayed drains, which is why this took many round-trips. Everything is confirmed landed."

The tells: tool *execution* is fine (writes land), but tool *result delivery* arrives batched and
late. That is the signature of (a) a background process contending for CPU/IO with the agent's
session, and/or (b) a flood of child-process stderr the client must drain — not of failing commands.

## What is shared across every affected repo

Exactly one thing changed when dogfooding started: each repo's `.claude/settings.json` now registers

```json
{ "mcpServers": { "openlore": { "command": "npx", "args": ["--yes", "openlore", "mcp"] } } }
```

A long-running `openlore mcp` stdio server, started with **no flags**. No git hooks are installed in
the affected repos (verified in `enklayve/.git/hooks` — empty), so the decisions/commit gate is **not**
the cause. The cause is in the MCP server's default behavior.

## Root cause (grounded against the code)

**`--watch-auto` defaults to `true`** — [src/cli/commands/mcp.ts:1610](../../src/cli/commands/mcp.ts#L1610):

```ts
.option('--watch-auto', 'Auto-detect the project directory from the first tool call and start watching', true)
```

So plain `openlore mcp` silently arms a recursive `chokidar` watcher on the **first** tool call that
carries a `directory` ([mcp.ts:1347-1362](../../src/cli/commands/mcp.ts#L1347-L1362)). From then on,
**every file the agent edits** fires `McpWatcher.handleChange`
([mcp-watcher.ts:191-273](../../src/core/services/mcp-watcher.ts#L191-L273)). The directory pruning
itself is well guarded (node_modules/dist/target/etc. are excluded — the EMFILE fix at
[mcp-watcher.ts:60-100](../../src/core/services/mcp-watcher.ts#L60-L100)); the defect is the **per-save
cost**, which is O(repo), not O(change). On a real dogfood target (`enklayve`: 2.1 MB `call-graph.db`,
**2.1 MB `llm-context.json`**, a LanceDB `vector-index/`), a single save does all of:

1. **Full `llm-context.json` rewrite.** `handleChange` reads → `JSON.parse` → patches one signature
   entry → writes the **entire** file back ([mcp-watcher.ts:247-267](../../src/core/services/mcp-watcher.ts#L247-L267)).
   That is a 2.1 MB parse + 2.1 MB write **per save**, regardless of edit size.

2. **A forced 2.1 MB re-parse on the next tool call.** `readCachedContext` caches the parsed context
   keyed on file **mtime** ([utils.ts:124-146](../../src/core/services/mcp-handlers/utils.ts#L124-L146)).
   The rewrite in (1) bumps mtime, so the next MCP query (which `orient`, `analyze_impact`,
   `get_subgraph`, `search_code`, etc. all depend on) must re-read and re-parse the whole 2.1 MB file
   cold. The watcher's write therefore taxes the read path too.

3. **A full vector-index read + overwrite.** `reEmbed` ([mcp-watcher.ts:269-319](../../src/core/services/mcp-watcher.ts#L269-L319))
   calls `VectorIndex.build(..., incremental=true)`. But the "incremental" path still
   `openTable()` → `table.query().toArray()` — reads the **entire** corpus into memory
   ([vector-index.ts:413-415](../../src/core/analyzer/vector-index.ts#L413-L415)) — then
   `createTable(TABLE_NAME, ..., { mode: 'overwrite' })` — rewrites the **whole** table
   ([vector-index.ts:472](../../src/core/analyzer/vector-index.ts#L472)). `incremental` only avoids
   *re-embedding* unchanged functions; the storage read and rewrite are full-corpus every time. The
   BM25-only path is the same shape (overwrite + corpus-cache bust).

4. **A stderr line per change** (and another per embed) — [mcp-watcher.ts:238-239, 267, 311-315](../../src/core/services/mcp-watcher.ts#L238-L239).

5. **No coalescing across files.** The debounce is **per-file** (a `setTimeout` per path,
   [mcp-watcher.ts:165-183](../../src/core/services/mcp-watcher.ts#L165-L183)); the `running` flag
   serializes but *reschedules* superseded work rather than dropping it. A bulk file event — `git
   checkout`/`rebase`/`pull`, a formatter, a project-wide find-replace — touching N source files
   therefore runs the full O(repo) pipeline **N times back-to-back**. A 50-file branch switch =
   50 full `llm-context.json` rewrites + 50 full vector-index overwrites, serialized.

**Net:** the freshness mechanism that Spec 13 sells as cheap is, in the field, an O(repo) re-index +
re-embed pipeline that fires on every keystroke-save and storms on every VCS operation — saturating
CPU/IO and flooding stderr in the MCP child process while the agent is trying to work. That is the
"batched result-delivery latency." The call-graph subset rebuild
([mcp-watcher.ts:206-244](../../src/core/services/mcp-watcher.ts#L206-L244)) is correctly bounded
(changed file + ≤10 callers) and is **not** the problem — items 1–5 are.

### Why this jumps the queue (ahead of Spec 14)

Spec 13 says "run the benchmark before writing another line of *feature* code." This is not feature
code — it is a regression that degrades every dogfooding session, and dogfooding is how 14–23 get
validated. A Spec 14 token/latency benchmark run *through* the MCP server while this is live would
also be polluted by watcher contention. Fix the substrate's freshness tax first; then benchmark.

---

## Goal & success criteria

**Goal:** incremental freshness is O(change), not O(repo), and never storms — so `--watch-auto`
stays on by default and a watching session is indistinguishable from a non-watching one in latency.

Verifiable criteria (see Step 8 for the harness):

- **G1** — A single source-file save triggers **≤ 1** `llm-context` persistence and **≤ 1** vector
  update, and does **not** force a full-file re-parse on the next tool call.
- **G2** — A burst of N saves within the debounce window coalesces to **1** flush, not N.
- **G3** — A VCS bulk event (≥ `BULK_THRESHOLD` files, or `.git/HEAD`/`.git/index` churn) produces
  **at most one** deferred refresh, not one pipeline per file.
- **G4** — Per-save wall-clock and CPU on a 2 MB-context repo drop by **≥ 10×** vs. today
  (measured; the benchmark sets the real number).
- **G5** — Watcher stderr emits **≤ 1** line per batch by default; per-file detail only with a debug flag.
- **G6** — `orient`/`search_code` still reflect a just-saved edit within the debounce window
  (freshness preserved — this is the whole point of keeping watch on).
- **G7** — No regression in the cold `analyze`/`--watch` path or in MCP read latency
  (`scripts/bench-mcp.ts`).

---

## The fix — detailed steps

> Design principle: **separate the two freshnesses.** *Signature/structure* freshness (what
> `orient`/`search_code` return as text) must land immediately and cheaply. *Embedding* freshness
> (semantic re-rank quality) may lag a few seconds and batch. Spec 13's thesis is the structural map;
> the vector layer is the optional semantic assist (Spec 06), so it can trail.

### Step 1 — Coalesce per-file events into a single batched flush

Replace the per-file timer map + reschedule loop ([mcp-watcher.ts:111, 165-183](../../src/core/services/mcp-watcher.ts#L165-L183))
with **one** coalescing queue:

- Maintain a `Set<string>` of pending changed paths plus a single debounce timer.
- On each `change`, add the path and (re)arm one timer (`debounceMs`, default 400). Add a hard
  **max-batch ceiling** so a continuous stream still flushes periodically
  (`maxBatchMs`, e.g. 2000) — never starve.
- On flush, drain the whole Set and process it as **one batch**: one call-graph subset build over
  all changed files, **one** `llm-context` persistence (Step 2), **one** vector update (Step 3).
- Keep single-flight: if a flush is running, accumulate into the next Set; do not interleave.

`handleChange(path)` stays exported for unit tests but becomes `handleBatch(paths)` internally; the
single-file form delegates to a batch of one.

### Step 2 — Make the `llm-context.json` update cheap and stop busting the read cache

The 2.1 MB rewrite-per-save and the mtime-driven re-parse are the two biggest single-save costs.
Pick **2a** (smallest change, recommended) and add **2c**; consider **2b** as the durable form.

- **2a — Write-behind + in-memory cache handoff (recommended first move).** Keep the patched context
  in memory; flush to `llm-context.json` at most once per `flushIntervalMs` (e.g. 2000) or on idle,
  not per save. Crucially, **update the read-path cache in place** so freshness does not require a
  disk round-trip: expose a setter on `readCachedContext`'s `_contextCache`
  ([utils.ts:115-146](../../src/core/services/mcp-handlers/utils.ts#L115-L146)) that the watcher calls
  with the new in-memory context, so the next tool call is a cache **hit** (no 2.1 MB re-parse) even
  before the disk flush. This satisfies G1, G2, G6 directly.
- **2b — Stop storing signatures in the monolith (durable form).** Signatures are the only thing the
  watcher patches into `llm-context.json`. Move per-file signatures to an incrementally updatable
  store — the `EdgeStore` SQLite already updated incrementally here is the natural home (one-row
  upsert per file), or a per-file sidecar. Then a single-file change is an O(1) row write, and
  `llm-context.json` is rebuilt only by `analyze`. Larger blast radius (read paths that consume
  `context.signatures` must read the new store); schedule after 2a proves the model.
- **2c — Cache invalidation that survives partial writes.** If any path keeps rewriting
  `llm-context.json`, make `readCachedContext` invalidation tolerate it: invalidate per-file rather
  than busting the whole parsed object, or have the watcher push the updated object into the cache
  (as in 2a) so an mtime bump never forces a cold full re-parse.

### Step 3 — Make the vector-index update a real incremental row op

Stop the full-table read+overwrite on the watch path.

- Replace `query().toArray()` + `createTable(overwrite)` ([vector-index.ts:404-472](../../src/core/analyzer/vector-index.ts#L404-L472))
  with **row-level** ops for the changed functions only: LanceDB `delete(predicate)` for the changed
  file's existing rows + `add(newRows)`, or `mergeInsert` keyed on function `id`. Add a dedicated
  `VectorIndex.updateFiles(outputDir, changedNodes, …)` entry point for the watcher so the cold
  `build()` path is untouched (protects G7 and the `analyze --embed` contract).
- For the **BM25-only** path (no embedder): update only the affected documents in the corpus and
  surgically invalidate just those entries in `_bm25Cache`
  ([vector-index.ts:191-202](../../src/core/analyzer/vector-index.ts#L191-L202)) instead of rebuilding
  and dropping the whole corpus cache.
- Likewise invalidate only the changed rows in `_tableCache`, not the whole table handle.

### Step 4 — Decouple embedding freshness from signature freshness

- On flush, run Step 2 (signatures) **synchronously and first** so `orient`/`search_code` reflect the
  edit immediately (G6). Schedule Step 3 (embedding/vector) as a **separate, lower-priority** task
  that may batch across multiple flushes and run on idle. Never block a signature update on an embed.
- Add a `watchEmbed` switch (config + `--watch-no-embed`) so large repos can run **signatures-only**
  live freshness and let embeddings refresh at commit (the post-commit `analyze --embed` the
  watcher header already references, [mcp-watcher.ts:10-11](../../src/core/services/mcp-watcher.ts#L10-L11)).
- **Auto-degrade on big repos:** if the watched tree exceeds `WATCH_EMBED_FILE_CEILING` source files,
  default to signatures-only live and log the decision once (no silent cap — state it, per Spec 13's
  "no claim outruns the code" discipline).

### Step 5 — Backpressure + VCS-flood detection

- **VCS detection:** watch for `.git/HEAD`, `.git/index`, `.git/MERGE_HEAD`, `ORIG_HEAD` churn, or a
  flush batch ≥ `BULK_THRESHOLD` files. On detection, **cancel** queued per-file work and schedule a
  **single** coalesced refresh after the operation settles (a quiet period), rather than N pipelines.
  A branch switch becomes one refresh (G3).
- **Backpressure:** if flush batches keep arriving faster than they drain (queue depth grows past a
  bound), degrade to "mark stale + one batched refresh on the next idle window" and emit a single
  `[mcp-watcher] coalesced N changes` line. Never let the queue grow unbounded.

### Step 6 — stderr discipline

- Default to **one summary line per batch** (`[mcp-watcher] updated N files (Mms)`); move the
  per-file/per-embed lines ([mcp-watcher.ts:238-239, 267, 311-315](../../src/core/services/mcp-watcher.ts#L238-L239))
  behind `OPENLORE_WATCH_DEBUG`. This removes the stderr-flood contribution to the client's batched
  result drain, independent of the CPU/IO win.

### Step 7 — Reconcile the docs/install text with reality

The current behavior contradicts the docs, which compounds the confusion:

- [docs/mcp-tools.md:56](../../docs/mcp-tools.md#L56) lists `--watch-auto` default as **`off`** — it is
  `true`. Fix the table to "on by default" and describe the new cheap batched behavior + the
  `--watch-no-embed` / signatures-only auto-degrade.
- [src/cli/install/index.ts:235](../../src/cli/install/index.ts#L235) and [README.md:183](../../README.md#L183)
  should state watch is on by default, why (live freshness), and how to disable
  (`openlore mcp --no-watch-auto`) or run signatures-only.
- The orient skill's stdio fallback spawns `npx --yes openlore mcp` with no flags
  ([skills/openlore-orient/scripts/orient-via-mcp.mjs:30](../../skills/openlore-orient/scripts/orient-via-mcp.mjs#L30)),
  so it too arms the watcher; for one-shot orient it should pass `--no-watch-auto` (the option's own
  help already claims the orient wrapper does this — make it true).

### Step 8 — Watch-mode microbenchmark + regression tests

- **Benchmark** (`scripts/bench-watch.ts`, sibling to `bench.ts`/`bench-mcp.ts`): on a fixture with a
  ~2 MB context + populated vector index, measure (a) single-save flush latency + CPU, (b) a 50-file
  bulk-change burst, asserting G1–G4. Record before/after in `BENCHMARKS.md`.
- **Tests** (extend `mcp-watcher.test.ts` / `.integration.test.ts`):
  - N change events in one window ⟹ exactly 1 persistence + 1 vector update (G2).
  - VCS-flood / ≥ BULK_THRESHOLD batch ⟹ exactly 1 deferred refresh (G3).
  - A save updates the in-memory read cache: the next `readCachedContext` is a **hit**, no full
    re-parse (G1).
  - `VectorIndex.updateFiles` changes only the target file's rows; corpus rows for other files are
    byte-identical (Step 3).
  - Signatures reflect a just-saved symbol within the debounce window even when the embedder is
    absent/slow (G4/G6, signatures-only path).
  - stderr emits ≤ 1 line per batch unless `OPENLORE_WATCH_DEBUG` (G5).

---

## Tunables (new) — single source of truth

Add to constants and surface in `.openlore/config.json` (and `--watch-*` flags). Defaults chosen to
keep watch **on** and cheap:

| Knob | Default | Purpose |
|---|---|---|
| `watchDebounceMs` | 400 | idle quiet period before a flush (existing) |
| `watchMaxBatchMs` | 2000 | hard flush ceiling under a continuous stream |
| `watchBulkThreshold` | 25 | batch size that trips VCS-flood handling |
| `watchEmbed` | `true` | run vector update live; `false` = signatures-only |
| `watchEmbedFileCeiling` | e.g. 5000 | above this, auto-degrade to signatures-only |
| `OPENLORE_WATCH_DEBUG` | unset | enable per-file/per-embed stderr lines |

---

## Compatibility & scope guarantee (per Spec 13's prime constraint)

This is **additive and behavior-preserving** for the frozen contract:

- **`mcp` CLI surface preserved.** `--watch`/`--watch-auto`/`--watch-debounce` keep their meaning;
  new flags (`--watch-no-embed`) are additive. Default stays on (owner's decision) — but now cheap.
- **Cold paths untouched.** `analyze` and `analyze --embed` build full `llm-context.json` and the full
  vector index exactly as today; Step 3 adds a *new* `VectorIndex.updateFiles` reader beside the
  existing `build()` rather than changing it (protects G7).
- **`orient()` response shape unchanged.** This is a latency/IO fix; no field is added, removed, or
  retyped.
- **`llm-context.json` format unchanged** under 2a/2c. If 2b lands later, signatures move to a store
  but the artifact stays valid (consumers migrate behind the existing readers); a `SCHEMA_VERSION`
  bump rebuilds from source — one re-analyze, no migration (the Spec 13 safety property).
- **Freshness guarantee strengthened, not weakened.** The point of keeping watch on is preserved
  (G6); we remove only the cost, not the freshness.

---

## Relationship to existing specs

- **Spec 13 (context substrate)** — direct parent. This is the "kept fresh incrementally so it never
  carries the staleness tax" claim, made true in the field. Add a 13.1 line to Spec 13's Progress
  list ahead of Spec 14.
- **Spec 06 (BM25 without embeddings)** — Step 4's signatures-only / `--watch-no-embed` mode is the
  watch-time expression of the same "deterministic retrieval, network/embeddings optional" floor.
- **Spec 14 (benchmark harness)** — runs *after* this; a token/latency benchmark through the MCP
  server is only trustworthy once the watcher no longer contends with the measured session.
- **PR #83 (Panic Response Layer)** — orthogonal; does not touch this pipeline (see Progress note).

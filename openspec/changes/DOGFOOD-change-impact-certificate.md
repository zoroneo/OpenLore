# Dogfood — change-impact certificate (add-change-impact-certificate, change 3)

> Ran the real `openlore impact-certificate` CLI against THIS repo (6,286 functions, freshly
> `openlore analyze`d) on 2026-06-21. Every requirement in the spec deltas was exercised end-to-end on a
> live index, not a mock. Branch `feat/change-impact-certificate`, stacked on `feat/working-set-context-briefing` (PR #180).

## Setup

Declared one critical covering surface in `.openlore/config.json` (local-only; reverted after the run):

```json
"impactCertificate": {
  "surfaces": [{ "name": "spec-store-binding", "severity": "critical",
                 "members": [{ "symbol": "validateSpecStoreConfig" }] }],
  "block": ["critical"]
}
```

Then made one controlled working-tree edit that opens a NEW path into that surface — a function that
did not previously reach `validateSpecStoreConfig` now calls it directly:

```ts
// src/cli/commands/impact-certificate.ts (scratch, reverted)
export function dogfoodNewlyOpensSurface(binding) {
  return validateSpecStoreConfig(binding, process.cwd());
}
```

## 1. Newly-opened-path detection (the differential core) — PASS

`openlore impact-certificate --base HEAD`:

```
📜 Change-impact certificate (advisory)
   2 file(s) / 31 symbol(s) changed; 1 new path(s) into 1 surface(s): spec-store-binding;
   ⛔ critical surface newly reached; 3 spec(s) may go stale.
   Surfaces: spec-store-binding (1 sym, critical)
   ⛔ NEW path into "spec-store-binding" (critical): dogfoodNewlyOpensSurface → validateSpecStoreConfig
   Tests to run (8): impact-certificate.test, boot, spec-store.test, working-set.test, …
   ⚠ 3 spec(s) may go stale
```

The differential correctly attributed the new reach to the exact opening edge
`dogfoodNewlyOpensSurface → validateSpecStoreConfig` and named the shortest path — computed with **no
full rebuild and no incremental dependency graph** (it is unbuilt). The opening function was brand-new
(absent from the pre-edit index) and was still named cleanly from its path-based id.

`--json` confirmed the conclusion shape: `newlyOpenedPaths`, `surfaces`, `impact` (reused from
`blast_radius`), `tests`, `specs`, `findings` with stable codes (`surface-critical`, `spec-drift`), and
`highestSurfaceSeverity: "critical"`. An ambiguous added call (`process.cwd()`) was honestly reported as
`unresolved-added-call` rather than guessed — the resolve-only-when-unique contract held.

## 2. Advisory by default + opt-in blocking — PASS

| Config | `--hook` exit | Behavior |
|--------|---------------|----------|
| `block: ["critical"]`, critical path opened | **1** | Blocked, with "commit blocked — opens a new path into a critical surface" on stderr |
| `block: []` (default), same critical path | **0** | Advisory: certificate printed, commit proceeds |

Infrastructure failure (no graph / not a repo) returns exit 0 — never blocks (unit-tested; the CLI maps
every `{error}` and any thrown handler to exit 0 in hook mode).

## 3. Decay via the freshness lease + persistence — PASS

`openlore impact-certificate --change add-change-impact-certificate --save` wrote
`.openlore/impact-certificates/add-change-impact-certificate.json` carrying **31 lease anchors**, each
with `nodeId`, `stableId`, `symbolName`, and `contentHash` — e.g.

```json
{ "nodeId": "src/cli/commands/impact-certificate.ts::installImpactCertificateHook",
  "stableId": "sid:installImpactCertificateHook(rootPath: string)",
  "symbolName": "installImpactCertificateHook", "contentHash": "c542fa85a70f6dfc" }
```

The unit suite (`impact-certificate.test.ts`, 17 tests) drives the fresh→stale transition against a real
on-disk edge store: a certificate reads `fresh` against the graph it was computed on, and turns `stale`
once an anchored symbol's body changes; `recheckPersistedCertificates` returns `[]` with no certs dir
(cheap gate), `[]` while fresh, and the stale change id after the edit. The spec-store health check
(`handleSpecStoreStatus`) surfaces a stale certificate in an indexed target as a `certificate-stale`
finding — exactly the "re-fire it" requirement — and emits none while the certificate is fresh.

## 4. Empty diff + no surfaces — PASS

- `--base HEAD` with a clean tree → `No changes vs HEAD — nothing to certify.`
- With no `impactCertificate.surfaces` declared, the certificate still reports blast radius, tests, and
  drift, and emits a single `no-surfaces-declared` info finding (no surface assessment claimed).

## Test + suite status

- `impact-certificate.test.ts` — 17 tests (surface resolution, the two differential scenarios + direct +
  already-reachable + empty, block gate, conclusion-shape/contract, decay + health-check re-fire). PASS.
- Full CI-equivalent suite (`vitest run src examples`, integration excluded): **4,376 passed / 2 skipped**.
- Tool-surface guards updated consciously: 62 → 63 tools, tools/list budget 63k → 64k, doc size figure
  ~58 KB → ~62 KB; presets/contract/tool-driver/count-doc guards all green.

## Scoped deviation (recorded, decision `187224b0`)

The post-change graph is derived by a bounded **differential edge-delta over the changed files** (the
same primitive `structural_diff` uses), not via `add-watch-incremental-dependency-graph` (a DRAFT). A new
call edge can only originate from a changed file, so re-parsing only the changed files at base vs working
tree and adjusting the canonical adjacency both ways (post = canonical + added − removed, pre = canonical
− added + removed) detects every newly-opened path without that dependency. Mechanism substitution only;
all spec requirements hold, as verified above.

---

## Round 2 — adversarial hardening (2026-06-21, PR #181 review)

Two independent adversarial reviewers + real-input e2e probes found two correctness bugs in the
changed-file plumbing (both stemming from `computeEdgeDelta` diverging from the sibling
`structural_diff`, which gets these right) and one no-throw gap. All three are fixed and regression-tested.

### BUG 1 — renamed files reported FALSE newly-opened paths (HIGH) — FIXED

`computeImpactCertificate` dropped `getChangedFiles`' `oldPath`, so for a rename `old.ts → new.ts`,
`computeEdgeDelta` read base-ref content via `git show <base>:new.ts` (which fails — the file lived at
`old.ts`). With no old snapshot, **every** pre-existing call in the renamed file looked *added*, so any
call it already made into a surface was falsely reported as newly-opened.

Reproduced e2e: a pure `git mv` of a file that already called `validateSpecStoreConfig` (a `critical`
surface) reported `newlyOpenedPaths: 1` — and under `block: ["critical"]` would have **wrongly blocked an
innocent rename commit**. Fix: thread `oldPath`/`status` through `ChangedFileEntry` and read old content
from `oldPath ?? path`. After: `newlyOpenedPaths: 0`.

### BUG 2 — brand-new untracked files were silently ignored (MEDIUM) — FIXED

`getChangedFiles` excludes untracked files (`git diff` does), so a brand-new file (not yet `git add`ed)
whose function opened a path into a surface was never parsed: `changed.files: 0`, `newlyOpenedPaths: 0` —
the certificate certified "no new reach" while a real critical opening existed. This is the exact mistake
the tool exists to prevent. Fix: fold in `git ls-files --others --exclude-standard` (as `structural_diff`
does). After: the untracked file's opening is detected (`newlyOpenedPaths: 1`, critical).

### BUG 3 — decay re-check could throw out of the no-throw health check (MEDIUM) — FIXED

`recheckCertificate` / `recheckPersistedCertificates` could throw (a corrupt anchor graph in a *target*
repo, or a wrong-typed persisted `lease.anchors`) out of `handleSpecStoreStatus`, which contractually
never throws. Fix: `recheckCertificate` now catches `AnchorContext.open`/view failures and a non-array
lease, returning a conservative `stale`; the spec-store call site wraps the re-check in try/catch as a
hard boundary.

### Regression tests added

`impact-certificate.test.ts` grew from 17 → 21 tests. Four new cases pin these against a **real temp git
repo** + the real `CallGraphBuilder` snapshot: a pure rename opens nothing (old content read from
`oldPath`); an untracked file's opening is detected (folded in via `ls-files`); an in-place new caller is
detected; and a corrupt/wrong-typed persisted certificate never throws. Full CI-equivalent suite:
**4,380 passed / 2 skipped**.

> Method note: an early e2e cleanup used `git reset --hard`, which silently reverted the in-progress
> source fixes while the already-built `dist/` kept passing — a reminder that CLI e2e runs the *built*
> artifact, so source-level verification (typecheck + unit tests against source) must gate the commit.


---

## Round 3 - second adversarial pass (2026-06-21, PR #181 review)

A fresh adversarial round (two reviewers + new real-input probes) found two more correctness bugs, a
file-hygiene defect, and documentation/test gaps. All fixed.

### BUG 4 - homonym phantom opening (HIGH) - FIXED

Resolving an added call's callee by NAME against the canonical graph mis-bound a LOCAL helper that
shares a covering-surface symbol's name to the canonical surface - a phantom newly-opened path that
**falsely trips the critical block-gate**. Reproduced e2e: an untracked file defining its own local
`validateSpecStoreConfig` and calling it reported `newlyOpenedPaths: 1` (critical). Fix: the per-file
snapshot already binds the call to the local definition, so we key changed-file calls by their resolved
snapshot-internal id (`id:<calleeId>`) and only name-resolve callees that are external to the snapshot
(cross-file calls). After: `newlyOpenedPaths: 0`. (Decision `97c22605`.)

### BUG 5 - a surface member ADDED in the same diff was missed (MEDIUM) - FIXED

`resolveSurfaces` ran over the canonical graph only, so a surface symbol created in the same diff was
unresolvable, so its critical opening was reported as `none` (downgraded to a `warn` unresolved-member
finding). Fix: resolve surfaces over canonical + post-change snapshot nodes; the certificate now computes
the edge delta before resolving surfaces so those nodes are available.

### BUG 6 - three NUL bytes embedded in the source (LOW) - FIXED

The handler carried three raw NUL bytes (accidental key separators), so `file(1)` read it as binary and
plain `grep` silently skipped it. Replaced with the `` escape sequence (identical runtime, valid UTF-8).

### Documentation + test coverage closed

- Docs: `change_impact_certificate` / `openlore impact-certificate` now has a full entry in
  `docs/mcp-tools.md` (table row + prose + parameters + finding codes), `docs/cli-reference.md` (command
  table row + reference subsection), `README.md` (situational tool table), and `docs/federation.md`
  (spec-store-arc completion). It previously appeared only in `CLAUDE.md`.
- Tests: added a CLI test file `src/cli/commands/impact-certificate.test.ts` (hook install/uninstall
  idempotency + coexistence + round-trip, and `runImpactCertificateCli` advisory/blocking exit codes incl.
  malformed/throwing config), a `dispatchTool(change_impact_certificate)` MCP-path reachability test, and
  regression tests for the homonym and same-diff-surface bugs against a real temp git repo.
  Suite: **4,399 passed / 2 skipped**.


---

## Round 4 - third adversarial pass (2026-06-21, PR #181 review)

A third adversarial round (fresh reviewer on scale/determinism/correctness + new real-input probes)
found two HIGH correctness bugs and several MEDIUM integrity gaps. All fixed and regression-tested.

### BUG 7 - base-ref divergence: the two halves of the certificate diffed against different commits (HIGH) - FIXED

`getChangedFiles` diffs against the MERGE-BASE (three-dot `base...HEAD`), but `computeEdgeDelta` read old
content from the base-ref TIP (`git show <ref>:path`). When the base branch advanced past the branch
point, the differential read a wrong baseline -> phantom or missed surface openings, while the blast
radius (which uses `getChangedFiles`) used the correct one. Reproduced in a temp git repo where both the
branch and the base independently add the same call: reading the base tip MISSES the genuine opening;
reading the merge-base detects it. Fix: `oldContentRef` resolves `git merge-base` and the differential
reads from that SHA. (Decision recorded this round.)

### BUG 8 - wrong-typed surface severity broke the block signal (HIGH) - FIXED

`surfacesFromConfig` validated only `name` and `members`, so a wrong-typed `severity` (e.g. `"high"`)
flowed through; `SEVERITY_RANK["high"]` is `undefined` -> `Math.max(rank, undefined)` is `NaN` ->
`highestSurfaceSeverity` was emitted as `null`, breaking the `CoveringSurfaceSeverity | "none"` contract
that an orchestrator's block check relies on. Reproduced e2e (`highestSurfaceSeverity: null`). Fix:
coerce any out-of-enum severity to `warn` in `surfacesFromConfig`, plus a `?? 0` guard at the rank
lookup. After e2e: severity coerced to `warn`, `highestSurfaceSeverity: "warn"`.

### Also fixed (MEDIUM/LOW)

- **Duplicate surface names** collided in the per-surface findings map (one severity silently dropped);
  `surfacesFromConfig` now drops duplicates (first wins).
- **Empty/whitespace surface names** are dropped (were emitting blank-subject findings).
- **A member with both `symbol` and `file`** now resolves both (the file was silently ignored).
- **Non-total sort** made the top-N paths non-deterministic on ties; the comparator is now a total order.
- **Silent per-surface path truncation**: the cap moved to the caller, the finding reports the TRUE count
  (`opens N (showing 12)`), and a truncation caveat is added (no-silent-truncation).
- **Unbounded large-diff parse**: a caveat is emitted past 200 changed files (capping would miss
  openings, so the work stays complete - only the cost is disclosed).
- **Lease incompleteness**: a new/untracked file (no indexed symbol) now gets a FILE-level anchor, so the
  certificate actually decays for the new code it certified; `changed.symbols` counts symbol anchors only.

### Documentation + tests

- `docs/configuration.md` now documents the `impactCertificate` config (surfaces, members, severity,
  block) - the last doc surface that lacked it.
- Regression tests added: merge-base baseline (real temp git repo), severity coercion / duplicate /
  empty-name (`surfacesFromConfig`), both-member resolution, and file-level-anchor decay.
  Full CI-equivalent suite: **4,405 passed / 2 skipped**.


---

## Round 5 - documentation accuracy + MCP-server integration (2026-06-21, PR #181 review)

A fourth adversarial pass (spec/doc-accuracy + integration-coverage reviewer + a real large-diff
performance probe) found no new runtime bugs - the differential, decay, config hardening, and finding
codes were all confirmed accurate - but surfaced 5 documentation inaccuracies and one integration gap.

### Doc inaccuracy: "incremental dependency graph" survived in normative spec/proposal bodies - FIXED

Three rounds of fixes settled the implementation on a differential edge-delta over changed files, and the
proposal header + canonical-spec NOTES recorded that deviation - but five requirement/claim BODIES still
asserted the un-shipped "incremental dependency graph" as the mechanism, contradicting the code (and their
own notes). Fixed all five: the canonical `mcp-handlers` NewlyOpenedPathDetection requirement text, the
change-delta spec (which had no correcting note - added one), the proposal "What changes" item 2 and
"Application to OpenLore", and tasks.md item 2. The requirement text is now mechanism-neutral ("applying
the change's diff to the call graph") with the differential edge-delta described in the note. Also extended
the canonical lease/decay note to record that new/untracked files get a FILE-level anchor (the decay
guarantee is now stronger than the prose said).

### Integration gap: the tool was only unit-dispatch-tested, never through the live MCP server - FIXED

The spec-12 conformance integration test exercised the real stdio MCP server but its ListTools check was
one-directional (every ADVERTISED tool is known) - it would not catch a tool defined in TOOL_DEFINITIONS
but never exposed on the wire, and it positively asserted only `orient`. Strengthened it to BIDIRECTIONAL
(every DEFINED tool is advertised) and added a positive assertion that `change_impact_certificate` is
advertised. Verified against the live server: 7/7 conformance tests pass, so the new tool is now confirmed
reachable end-to-end through the actual MCP stdio server (not just the unit-level dispatchTool path). The
bidirectional check protects every tool, not just this one.

### Performance probe (real input): a 300-file diff

Measured `computeEdgeDelta` + `detectNewlyOpenedPaths` on a synthetic 300-file diff where every file newly
calls a critical surface symbol: collectChangedFiles 62ms, computeEdgeDelta ~8.8s (300 sequential
`git show` + two tree-sitter builds), detect 1ms; 300/300 openings correctly detected, no hang. This
validates the round-4 design call: the >200-file caveat fires, and capping the parse is correctly avoided
(it would miss openings) - only the cost is disclosed. The cost is inherent and bounded to changed files.

### Confirmed accurate (no change)

Finding codes (8) match `docs/mcp-tools.md` exactly; all documented CLI flags exist (added the
`--uninstall-hook` example for symmetry); no CHANGELOG file exists, so no release-notes omission. Full
CI-equivalent suite: **4,405 passed / 2 skipped**; conformance integration: **7 passed**.

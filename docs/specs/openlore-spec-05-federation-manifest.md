# OpenLore Spec 05 — Federation Manifest Emitter (`.well-known/openlore.json`)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Progress

Branch: `openlore-spec-05-federation-manifest`. Emitter + validator shipped; federation index deferred per scope.

> **Status (verified 2026-06-09): IMPLEMENTED (core).** The manifest emitter, JSON Schema, and
> `manifest emit`/`validate` CLI shipped. The remaining open boxes below are **deferred-by-design,
> not pending work**: the four `TODO(spec-05-followup)` items are analyzer enhancements (HTTP-route
> detectors, events/gRPC surfacing, per-package first-use) that need new analyzer capability, and the
> federation index is explicitly "a separate, larger spec." Do not treat these as buildable in a
> routine open-work sweep.

- [x] JSON Schema `schemas/openlore-manifest-v1.json` (version `1`); added `schemas/` to `package.json` `files` so it ships and `validate` can load it at runtime
- [x] `openlore manifest emit [--out --project-root --include-private --max-symbols]` and `openlore manifest validate <path>` (`src/cli/manifest/`, registered in `src/cli/index.ts`)
- [x] Detectors reuse existing analyzer output only: `public-symbols.ts` (entry-point exports resolved to definitions via dependency-graph + call graph; public methods of exported classes), `http-routes.ts` (route inventory verbatim), `events.ts` (empty + TODOs — analyzer doesn't surface events/RPC)
- [x] Pure `buildManifest()` + deterministic `serializeManifest()`; `generated_at` = HEAD commit date (not wall-clock) so output is byte-stable per commit
- [x] Hand-written tiny JSON-Schema-subset validator (`schema-validator.ts`) — no Ajv, per criterion 9
- [x] Tests (co-located — `test/` is gitignored): `manifest.test.ts` (17, pure `buildManifest` + validator negatives) and `emit-e2e.test.ts` (7, real `runManifestEmit`/`runManifestValidate` over a temp-dir fixture: artifact loaders, package entry-point resolution, git wiring, file write, validate exit codes). 24 tests total.
- [x] Confirmed remaining items genuinely require *extending the analyzer* (forbidden by scope): no event/messagebus extractor exists, no structured gRPC inventory, and `externalImports` is parsed per-file but never persisted to an artifact. Empty arrays + TODOs are the correct, scope-respecting behavior.
- [x] `docs/federation.md` (with forward-looking federation-index note) + README "Federation" section
- [x] Acceptance check on this repo: `manifest emit` → `.well-known/openlore.json` is **7,344 bytes ≤ 100KB**, validates (`manifest validate` exits 0), byte-identical across runs
- [x] `lint`, `typecheck`, `test:run` (2806 pass), `build` (schema packaged; built CLI emit+validate verified) all green
- [ ] `TODO(spec-05-followup): more framework detectors` (HTTP routes)
- [ ] `TODO(spec-05-followup): surface events_emitted / events_consumed from analyzer`
- [ ] `TODO(spec-05-followup): surface rpc_endpoints (gRPC) from analyzer`
- [ ] `TODO(spec-05-followup): first_use for external packages` (needs persisted per-file import sources)
- [ ] Federation index that ingests manifests cross-repo — separate, larger spec

---

## Context for you (the agent)

OpenLore's single-repo value proposition is well-defined. The next frontier is **cross-repo**: organizations with 50–500 repos cannot get agent context out of single-repo tools, because the most valuable orientation questions (who calls `BillingService.refund`, where is event X consumed, how does data flow from service A to service B) cross repo boundaries.

The full cross-repo solution — a federated index that ingests manifests from many OpenLore-instrumented repos and serves cross-repo `orient()` answers — is multiple PRs of work. **This PR ships only the first half: the emitter.** Each OpenLore-instrumented repo learns to publish a small, public, deterministic JSON manifest at `.well-known/openlore.json` describing what it exposes. Future PRs (separate specs) will build the federation index that reads these manifests.

This is the SBOM-of-cognition approach: every repo describes itself in a standard shape; the central index becomes a thin merger rather than a giant analyzer.

## Scope contract — do not break these things

This PR must NOT:

- Build the federation index. (That is a separate, larger spec.)
- Make network calls or upload anything anywhere.
- Change graph schema or MCP tools.
- Make the manifest required. Repos that don't emit one continue to work exactly as today.

This PR must:

- Be a pure file-emission feature. Run `openlore manifest emit` → write `.well-known/openlore.json`. That is the entire runtime surface.
- Produce a byte-stable manifest given the same graph + git state.
- Be small enough to commit: even for a large repo, the manifest should be <500KB. Use compact representations.
- Document the manifest schema with version pinning so future federation indices can rely on it.

## The deliverable

### Manifest schema (version `1`)

`.well-known/openlore.json`:

```jsonc
{
  "openlore_manifest_version": 1,
  "generated_at": "<iso8601>",
  "generator": { "name": "openlore", "version": "<pkg.version>" },
  "repo": {
    "name": "<package.json name or git remote basename>",
    "git_remote": "<origin URL if available, else null>",
    "git_commit": "<short SHA of HEAD>",
    "default_branch": "<as detected>"
  },
  "languages": [{ "name": "typescript", "files": 142, "functions": 1830 }],
  "stats": {
    "functions": 1830,
    "files": 142,
    "modules": 31,
    "avg_mccabe": 4.2,
    "clusters": 14
  },
  "exports": {
    "public_symbols": [
      { "name": "BillingService.refund", "kind": "method", "file": "src/billing/index.ts", "line": 84 }
      // ... only PUBLIC api surface; see below
    ],
    "http_routes": [
      { "method": "POST", "path": "/api/refund", "handler": "src/api/refund.ts:handleRefund" }
    ],
    "rpc_endpoints": [
      { "kind": "grpc", "service": "Billing", "method": "Refund", "handler": "..." }
    ],
    "events_emitted": [
      { "name": "billing.refund.completed", "schema_ref": "events/billing/refund-completed.schema.json", "emitter": "src/billing/index.ts:notifyRefund" }
    ],
    "events_consumed": [
      { "name": "billing.refund.requested", "handler": "..." }
    ]
  },
  "imports": {
    "external_packages": [
      { "name": "stripe", "version_range": "^14.0.0", "first_use": "src/billing/index.ts" }
    ]
  },
  "specs": {
    "count": 8,
    "drift_state": "clean" // or "drifted", "unverified"
  },
  "links": {
    "repo": "<git remote URL>",
    "docs": "<repo URL + /docs if exists>"
  }
}
```

This schema must be **versioned**. Future federation specs will rely on `openlore_manifest_version`. If you must change anything fundamental, bump the version and keep emitting `1` as well (dual-emit) — but for this PR, just ship version `1`.

### CLI surface

```
openlore manifest emit [--out <path>] [--include-private] [--max-symbols <int>]
openlore manifest validate <path>     # schema-checks an existing manifest
```

Behavior:

- `emit` defaults to writing `.well-known/openlore.json` at repo root.
- **`exports.public_symbols`** by default only includes symbols that look public for the language (TS: exported from package entry point; Python: in `__all__` or top-level non-underscore-prefixed in an importable module; etc.). `--include-private` includes everything (will produce a big file).
- `--max-symbols <int>` truncates the public-symbol list with a `"truncated": true` flag so the manifest stays small for huge repos.
- `validate` reads the JSON, checks against the schema, exits 0 if valid, prints diffs if not.

### Detection heuristics (be conservative)

- **HTTP routes**: detect via patterns OpenLore already understands (Express `app.<method>(...)`, Fastify, NestJS decorators, FastAPI decorators, etc.). Use whatever the existing analyzer already extracts; do NOT add new framework parsers in this PR. If none are detected, emit an empty array. Leave `TODO(spec-05-followup): more framework detectors`.
- **Events**: detect emitter/consumer patterns the existing analyzer already knows. Empty arrays are fine.
- **gRPC/RPC**: same conservative approach. Only emit what is already detected.

### Schema file

Ship the schema as JSON Schema at `schemas/openlore-manifest-v1.json` so consumers can validate independently. Reference it from the manifest:

```json
{ "$schema": "https://raw.githubusercontent.com/clay-good/OpenLore/main/schemas/openlore-manifest-v1.json", ... }
```

(Use the canonical clay-good repo URL. If the repo URL changes, update once.)

### Documentation

`docs/federation.md` (~one page): the cross-repo vision in one paragraph, the manifest schema, how to emit, how to consume (forward-looking note — "future versions of OpenLore will ship a federation index that reads these"), examples.

## Files you will create or modify (approximate)

```
src/cli/manifest/
  index.ts             # subcommand dispatch
  emit.ts              # the emitter
  validate.ts          # schema validator
  detect/              # detection helpers (reuse existing analyzer outputs)
    public-symbols.ts
    http-routes.ts
    events.ts
src/cli/index.ts       # register subcommand
schemas/openlore-manifest-v1.json
docs/federation.md
test/cli/manifest/
  emit.test.ts
  validate.test.ts
  fixtures/            # small fixture repos
README.md              # add "Federation" section linking to docs
```

## Acceptance criteria

1. `openlore manifest emit` against the OpenLore repo itself produces a valid `.well-known/openlore.json` ≤ 100KB.
2. The emitted file validates against the JSON Schema (assert in test).
3. Running emit twice on the same graph + commit produces byte-identical output.
4. `openlore manifest validate .well-known/openlore.json` exits 0 on the file we just emitted.
5. The schema file is committed and the manifest's `$schema` field points to it.
6. `--include-private` and `--max-symbols` work as documented.
7. `docs/federation.md` exists with the forward-looking note.
8. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass.
9. No new runtime dependencies (use the existing JSON Schema validator if one is already a dep; otherwise hand-write a small validator or use a tiny built-in approach — do NOT add Ajv just for this).

## Git workflow — read carefully

1. Branch: `openlore-spec-05-federation-manifest` off the default branch.
2. Implement emit + validate ONLY. Do not start on the federation index, the central server, the cross-repo query layer, or anything that consumes manifests across repos. Those are future specs.
3. **Open exactly one PR** titled `spec-05: federation manifest emitter (.well-known/openlore.json)`. Body must include the emitted manifest for this repo as a code block (or attached file) so reviewers can eyeball the shape.
4. All follow-up commits for this spec push to the same PR. Never open a second PR. If the schema needs revision, push the revision to the existing branch.
5. If a detection (HTTP routes, events, etc.) is impossible because the existing analyzer doesn't surface that information, emit an empty array and leave a `TODO(spec-05-followup): surface X from analyzer`. Do not extend the analyzer in this PR.
6. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

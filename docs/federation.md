# Federation Manifest

OpenLore's single-repo value is well-defined. The next frontier is **cross-repo**: organizations with dozens or hundreds of repos can't answer the questions that matter most — who calls `BillingService.refund`, where is event `X` consumed, how does data flow from service A to service B — because those questions cross repo boundaries. The federation approach is "SBOM-of-cognition": every repo describes itself in a standard shape at `.well-known/openlore.json`, and a future central index becomes a thin merger of those manifests rather than a giant cross-repo analyzer.

**This is the emitter half.** Each OpenLore-instrumented repo can publish its manifest today. The federation index that ingests them across repos is a separate, later piece of work — see "What's next" below.

## Emitting a manifest

```bash
openlore analyze                 # build the graph (if you haven't already)
openlore manifest emit           # writes ./.well-known/openlore.json
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--out <path>` | `<project-root>/.well-known/openlore.json` | Output path |
| `--project-root <path>` | current directory | Repo to describe |
| `--include-private` | off | Include non-public symbols (much larger manifest) |
| `--max-symbols <int>` | unlimited | Cap `public_symbols`, setting `"truncated": true` |

The manifest is **public**, **small** (default well under 100KB even for large repos, because `public_symbols` defaults to the package's exported entry-point surface), and **byte-deterministic**: `generated_at` is derived from the HEAD commit date (not wall-clock), and every array is sorted, so re-emitting on the same graph + commit produces an identical file. That makes it safe to commit to the repo and diff in review.

## Validating

```bash
openlore manifest validate .well-known/openlore.json
```

Exits `0` if the file conforms to [`schemas/openlore-manifest-v1.json`](../schemas/openlore-manifest-v1.json), or `1` with a list of schema violations. Validation uses a small built-in checker — no extra dependency.

## What's in the manifest (schema version `1`)

```jsonc
{
  "$schema": "https://raw.githubusercontent.com/clay-good/OpenLore/main/schemas/openlore-manifest-v1.json",
  "openlore_manifest_version": 1,
  "generated_at": "<HEAD commit ISO-8601>",
  "generator": { "name": "openlore", "version": "<pkg.version>" },
  "repo": { "name": "...", "git_remote": "...", "git_commit": "<short sha>", "default_branch": "main" },
  "languages": [{ "name": "typescript", "files": 142, "functions": 1830 }],
  "stats": { "functions": 1830, "files": 142, "modules": 31, "avg_mccabe": 4.2, "clusters": 14 },
  "exports": {
    "public_symbols": [{ "name": "BillingService.refund", "kind": "method", "file": "src/billing/index.ts", "line": 84 }],
    "http_routes": [{ "method": "POST", "path": "/api/refund", "handler": "src/api/refund.ts:handleRefund" }],
    "rpc_endpoints": [],
    "events_emitted": [],
    "events_consumed": []
  },
  "imports": { "external_packages": [{ "name": "stripe", "version_range": "^14.0.0" }] },
  "specs": { "count": 8, "drift_state": "unverified" },
  "links": { "repo": "<url>", "docs": "<url>/tree/main/docs" }
}
```

### How fields are derived

- **`public_symbols`** — by default, the symbols exported from the package entry point (TS/JS: `package.json` `main`/`exports`, following re-exports to their definition for an accurate `file`/`line`/`kind`), plus the public methods of any exported class. For languages without entry-point export data, top-level non-underscore functions are used. `--include-private` drops this filter.
- **`http_routes`** — taken verbatim from the analyzer's existing route inventory (Express, Fastify, NestJS, FastAPI, …). No new framework parsers are added by the manifest.
- **`stats` / `languages`** — counted from the call graph (functions, files, modules, McCabe average, community clusters).
- **`external_packages`** — declared dependencies from `package.json`.
- **`specs`** — count of `openspec/specs/*/spec.md`; `drift_state` is `"unverified"` (the emitter does not run drift detection).

### Conservative by design

`rpc_endpoints`, `events_emitted`, and `events_consumed` are emitted as empty arrays today: the current analyzer does not surface gRPC services or message-bus events as structured data, and the manifest never guesses. The schema already has a place for them, so a later analyzer change can populate them without a schema bump.

Known follow-ups (will not change schema v1):
- `TODO(spec-05-followup): more framework detectors` (HTTP routes)
- `TODO(spec-05-followup): surface events_emitted / events_consumed from analyzer`
- `TODO(spec-05-followup): surface rpc_endpoints (gRPC) from analyzer`
- `TODO(spec-05-followup): first_use` for external packages (needs persisted per-file import sources)

## Schema stability

`openlore_manifest_version` is `1` and the schema is committed at [`schemas/openlore-manifest-v1.json`](../schemas/openlore-manifest-v1.json). Future federation indices can rely on it. If a fundamentally incompatible change is ever needed, the version bumps and (per the spec) v1 keeps being emitted alongside the new version.

## What's next (forward-looking)

A future version of OpenLore will ship a **federation index** that reads many of these manifests and answers cross-repo `orient()` questions — cross-repo call chains, event producer/consumer maps, and service-to-service data flow. Because each repo self-describes in this stable shape, the index stays a thin merger. That work is intentionally out of scope here; this PR ships only the emitter and validator.

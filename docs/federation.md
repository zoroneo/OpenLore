# Federation Manifest

OpenLore's single-repo value is well-defined. The next frontier is **cross-repo**: organizations with dozens or hundreds of repos can't answer the questions that matter most — who calls `BillingService.refund`, where is event `X` consumed, how does data flow from service A to service B — because those questions cross repo boundaries. The federation approach is "SBOM-of-cognition": every repo describes itself in a standard shape at `.well-known/openlore.json`, and a future central index becomes a thin merger of those manifests rather than a giant cross-repo analyzer.

**This is the emitter half.** Each OpenLore-instrumented repo can publish its manifest today. The *hosted, manifest-merging* federation index that ingests them across many repos is a separate, later piece of work — see "What's next" below.

> **Already shipping — the local registry index-of-indexes.** A deterministic, local-first slice of cross-repo already works without any hosted index or manifest. A project-local registry (`.openlore/federation.json`) references each peer repo's own independently-built `.openlore` index, and the four conclusion tools answer across the fleet on demand. It is distinct from the manifest emitter on this page: the registry consumes each repo's *full* `.openlore` index by path (local-first); the manifest is the small, public, committable self-description a *future hosted* index will merge. See [The federation registry](#the-federation-registry-shipped) below.

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

## The federation registry (shipped)

The local-first cross-repo layer is live today. Federation is an **index-of-indexes**: each repo keeps its own independently-built `.openlore` index, and a project-local registry references them. No merged cross-repo graph is ever materialized — federated queries load only the per-repo indexes they need, on demand. Adding or removing a repo edits only the registry plus that repo's own build, never a global rebuild.

```bash
openlore federation add ../billing-service --name billing   # register a peer repo's index
openlore federation list                                    # ✓ indexed / ⚠ stale / ∅ unindexed / ✗ missing
openlore federation remove billing                          # alias: rm
```

Once peers are registered, four conclusion tools accept an opt-in `federation` (boolean) or `federationRepos` (name list) parameter and answer across the fleet — never returning a union graph, always naming `reposConsulted` vs `reposSkipped`, never guessing for an unindexed or stale repo:

| Tool | Cross-repo conclusion |
|------|------------------------|
| `analyze_impact` | who across the fleet *consumes* a published symbol |
| `find_dead_code` | whether an export is dead *everywhere*, or kept **live-via-federation** by a consumer |
| `select_tests` | which consumer-repo tests a change to a published symbol touches |
| `find_path` | when the goal symbol isn't local, the cross-repo *producer* + the home **bridge** call site |

Cross-repo resolution is deterministic: a consumer's external call site is matched to a producer symbol by the **stable-ID name descriptor** (content-addressed stable symbol IDs, the same key SCIP/Kythe monikers use). It is exact on the name and honest in `caveats` that a call site carries no signature, so arity is unconfirmed and a bare exported-name collision across packages is possible.

The capability is **opt-in**: the registry-status tool `federation_status` and the federation scope are exposed only under `openlore mcp --preset federation`. The default and `minimal` surfaces register no federation capability. See [docs/cli-reference.md](cli-reference.md#federation-multi-repo) for the full CLI and index-state semantics.

### Spec-store binding (built on the registry)

The registry above answers "which peer repos exist and are they indexed." A **spec-store binding** sits one layer up: it points OpenLore at an external **spec store** — a standalone repository that holds specs/changes — and declares the code repositories that store's plans are *about* (`targets`) and the ones they draw on for *context* (`references`). Those `targets`/`references` are **names**, resolved against the same federation registry — so the binding adds no new index machinery; it is a thin declarative layer over the index-of-indexes.

Configure it in `.openlore/config.json` (see [docs/configuration.md](configuration.md#spec-store-binding)) and check its health:

```bash
openlore spec-store status            # per-target resolution + index state, references, store path
openlore spec-store status --json     # stable finding codes for an orchestrator
```

`spec_store_status` (the matching MCP tool, also under `--preset federation`) is read-only and conclusion-shaped: it never throws — a corrupt registry degrades to a `registry-unreadable` finding rather than an error — and never blocks. It is the foundation of a broader, now-complete integration: `working_set_context` assembles the structural briefing an active change needs across the declared targets, and `change_impact_certificate` certifies what a change *newly opens* into declared covering surfaces before it lands (and `spec_store_status` re-fires a stale certificate as a `certificate-stale` finding). Both build on this binding.

### Honest limits

- **Staleness is only as fresh as each peer's last real `analyze`.** A peer is flagged `stale` by comparing its registered fingerprint against the one written to `.openlore/analysis/fingerprint.json` — which only changes when `openlore analyze` actually rebuilds. If you edit a peer and re-run `analyze` inside its recency window (the analyze TTL short-circuits the rebuild), the fingerprint does not move and the peer still reads as `indexed`. Run `openlore analyze --force` in a peer to be certain its index — and therefore its federation freshness — is current.
- **Cross-repo resolution matches on `external`-confidence call edges.** If a consumer repo *both* imports a peer's symbol *and* defines its own local symbol of the same name, the analyzer resolves the call to the local node, so that consumer will not appear as a cross-repo consumer (a quiet false-negative, the inverse of the disclosed cross-package name-collision risk).

## What's next (forward-looking)

A future version of OpenLore will ship a **hosted, manifest-merging federation index** that reads many of the manifests described above and answers cross-repo `orient()` questions across an organization without each consumer needing every peer's full `.openlore` index on local disk — cross-repo call chains, event producer/consumer maps, and service-to-service data flow. Because each repo self-describes in this stable shape, that index stays a thin merger. It complements the local registry above (which already covers the local-first case); the manifest emitter and validator on this page are its inputs.

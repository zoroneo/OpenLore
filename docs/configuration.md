## Configuration

`openlore init` creates `.openlore/config.json`:

```json
{
  "version": "1.0.0",
  "projectType": "nodejs",
  "openspecPath": "./openspec",
  "analysis": {
    "maxFiles": 500,
    "includePatterns": [],
    "excludePatterns": []
  },
  "generation": {
    "model": "claude-sonnet-4-20250514",
    "domains": "auto"
  }
}
```

### Environment Variables

| Variable | Provider | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | `anthropic` | Anthropic API key |
| `ANTHROPIC_API_BASE` | `anthropic` | Custom base URL (proxy / self-hosted) |
| `OPENAI_API_KEY` | `openai` | OpenAI API key |
| `OPENAI_API_BASE` | `openai` | Custom base URL (Azure, proxy...) |
| `OPENAI_COMPAT_API_KEY` | `openai-compat` | API key for OpenAI-compatible server |
| `OPENAI_COMPAT_BASE_URL` | `openai-compat` | Base URL, e.g. `https://api.mistral.ai/v1` |
| `GEMINI_API_KEY` | `gemini` | Google Gemini API key |
| `COPILOT_API_BASE_URL` | `copilot` | Base URL of the copilot-api proxy (default: `http://localhost:4141/v1`) |
| `COPILOT_API_KEY` | `copilot` | API key if the proxy requires auth (default: `copilot`) |
| `EMBED_BASE_URL` | embedding | Base URL for the embedding API (e.g. `http://localhost:11434/v1`) |
| `EMBED_MODEL` | embedding | Embedding model name (e.g. `nomic-embed-text`) |
| `EMBED_API_KEY` | embedding | API key for the embedding service (defaults to `OPENAI_API_KEY`) |
| `DEBUG` | -- | Enable stack traces on errors |
| `CI` | -- | Auto-detected; enables timestamps in output |

### Spec-store binding

An optional `specStore` block in `.openlore/config.json` binds this repository to an external **spec store** — a standalone repository that holds specs/changes — and declares the code repositories its plans are about. It is configuration only: OpenLore reads the declared relationships and never clones, writes to, syncs, or fences the store or any target. Omit the block entirely for unchanged single-repository behavior.

```json
{
  "specStore": {
    "name": "team-plans",
    "path": "../team-plans",
    "targets": ["api", "web"],
    "references": ["design-system"]
  }
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `name` | yes | a stable, user-facing name for the store |
| `path` | yes | absolute or repo-relative path to the external spec repository |
| `targets` | yes | federation-registered names of the code repositories the store's work is *about* |
| `references` | no | federation-registered names of repositories the store draws on for *context* |

`targets` and `references` are **names**, not paths: each must match a repository registered with `openlore federation add … --name <name>` (see [Federation](federation.md)). Check the binding's health with `openlore spec-store status` ([CLI reference](cli-reference.md#spec-store-binding)); it reports per-target resolution, index freshness, reference presence, and store-path presence as findings with stable codes, and never blocks.

### Covering surfaces (change-impact certificate)

An optional `impactCertificate` block declares the **covering surfaces** the change-impact certificate assesses a diff against — semantic or governance boundaries (a client surface, a data-handling surface, a regulated interface), not directory globs. Omit it entirely and the certificate still reports blast radius, drifted specs, and tests; declaring surfaces additionally reports the paths a change *newly opens* into each. See [`openlore impact-certificate`](cli-reference.md#change-impact-certificate) and the [`change_impact_certificate` MCP tool](mcp-tools.md).

```json
{
  "impactCertificate": {
    "surfaces": [
      {
        "name": "client",
        "severity": "critical",
        "members": [
          { "symbol": "renderResponse" },
          { "file": "src/api/public.ts" }
        ]
      }
    ],
    "block": ["critical"]
  }
}
```

| Field | Required | Meaning |
|-------|:---:|---------|
| `surfaces[].name` | yes | a stable, user-facing surface name (must be unique; empty names and duplicates are dropped) |
| `surfaces[].members` | yes | the boundary's members: each is a `{ "symbol": "<name>" }` (resolved to exactly one indexed symbol — ambiguous/unknown becomes a finding, never guessed) and/or a `{ "file": "<repo-relative path>" }` (all of the file's symbols). A member may set both. |
| `surfaces[].severity` | no | `info` \| `warn` \| `critical` (default `warn`); any other value is coerced to `warn` |
| `block` | no | severities the **advisory git hook** should fail a commit on (e.g. `["critical"]`). Empty/absent = advisory-only (the default). Infrastructure failure never blocks. |

A surface is resolved against the indexed graph (plus any symbol the same diff just added). The certificate is advisory by default and decays via the code-anchored freshness lease; when an anchored symbol later moves, `openlore spec-store status` re-fires a persisted certificate as a `certificate-stale` finding.


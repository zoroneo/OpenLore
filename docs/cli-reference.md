## Commands

| Command | Description | API Key |
|---------|-------------|---------|
| `openlore init` | Initialize configuration | No |
| `openlore analyze` | Run static analysis | No |
| `openlore generate` | Generate specs from analysis | Yes |
| `openlore generate --adr` | Also generate Architecture Decision Records | Yes |
| `openlore verify` | Verify spec accuracy | Yes |
| `openlore drift` | Detect spec drift (static) | No |
| `openlore drift --use-llm` | Detect spec drift (LLM-enhanced) | Yes |
| `openlore drift --suggest-tests` | After drift, list test files covering affected domains | No |
| `openlore audit` | Report spec coverage gaps: uncovered functions, hub gaps, stale domains | No |
| `openlore test` | Generate spec-driven tests (Vitest / Playwright / pytest / GTest / Catch2) | No |
| `openlore test --coverage` | Report which spec scenarios have corresponding tests | No |
| `openlore digest` | Plain-English summary of all specs for human review | No |
| `openlore prove` | Measure OpenLore's token value on your repo (WITH vs WITHOUT agent pass) | Yes |
| `openlore prove --estimate` | Deterministic, graph-derived projection of the orientation tax — no agent, no key | No |
| `openlore prove --json\|--markdown\|--save` | CI-consumable scorecard / paste-ready block + badge / dated record under `.openlore/prove/` | Matches arm |
| `openlore decisions` | Manage architectural decisions: list, approve, reject, sync to specs and ADRs | No |
| `openlore decisions --install-hook` | Install the pre-commit hook that gates commits until decisions are reviewed | No |
| `openlore run` | Full pipeline: init, analyze, generate | Yes |
| `openlore view` | Launch interactive graph & spec viewer in the browser | No |
| `openlore setup` | Install workflow skills into the project (Vibe, Cline, GSD, BMAD, Pi) | No |
| `openlore federation add\|remove\|list` | Manage the multi-repo federation registry (index-of-indexes) | No |
| `openlore spec-store status` | Report the health of the spec-store binding (read-only, advisory) | No |
| `openlore working-set context` | Assemble the working-set briefing for an active change across its targets (read-only, advisory) | Targets indexed |
| `openlore impact-certificate` | Certify what the current diff opens into declared covering surfaces, before it lands (advisory; opt-in blocking) | Yes |
| `openlore enforce` | Unified finding-enforcement gate: resolve every governance finding through `enforcement.policy` and block only on a `blocking`-classed finding (advisory by default) | Decisions/specs present |
| `openlore plugin-manifest emit\|validate` | Inspect/validate the OpenSpec plugin manifest (distinct from the federation `manifest`) | No |
| `openlore mcp` | Start MCP server (stdio, for Cline / Claude Code) | No |
| `openlore serve` | Start a warm local HTTP daemon exposing tools (loopback, for Pi / editors) | No |
| `openlore doctor` | Check environment and configuration for common issues | No |
| `openlore refresh-stories` | Refresh story files with latest structural context after each commit | No |

### Global Options

```bash
--api-base <url>       # Custom LLM API base URL (proxy / self-hosted)
--insecure             # Disable SSL certificate verification
--config <path>        # Config file path (default: .openlore/config.json)
-q, --quiet            # Errors only
-v, --verbose          # Debug output
--no-color             # Plain text output (enables timestamps)
```

Generate-specific options:
```bash
--model <name>         # Override LLM model (e.g. gpt-4o-mini, llama3.2)
```

### Drift Options

```bash
openlore drift [options]
  --base <ref>           # Git ref to compare against (default: auto-detect)
  --files <paths>        # Specific files to check (comma-separated)
  --domains <list>       # Only check specific domains
  --use-llm              # LLM semantic analysis
  --json                 # JSON output
  --fail-on <severity>   # Exit non-zero threshold: error, warning, info
  --max-files <n>        # Max changed files to analyze (default: 100)
  --verbose              # Show detailed issue information
  --suggest-tests        # List test files covering drifted domains
  --install-hook         # Install pre-commit hook
  --uninstall-hook       # Remove pre-commit hook
```

### Generate Options

```bash
openlore generate [options]
  --model <name>         # LLM model to use
  --dry-run              # Preview without writing
  --domains <list>       # Only generate specific domains
  --merge                # Merge with existing specs
  --no-overwrite         # Skip existing files
  --adr                  # Also generate ADRs
  --adr-only             # Generate only ADRs
  --force                # Re-run all LLM stages, clear generation cache, remove stale domains
  --analysis <path>      # Path to existing analysis directory
  --output-dir <path>    # Override openspec output location
  -y, --yes              # Skip confirmation prompts
```

### Run Options

```bash
openlore run [options]
  --force                # Reinitialize even if config exists
  --reanalyze            # Force fresh analysis even if recent exists
  --model <name>         # LLM model to use for generation
  --dry-run              # Show what would be done without making changes
  -y, --yes              # Skip all confirmation prompts
  --max-files <n>        # Maximum files to analyze (default: 500)
  --adr                  # Also generate Architecture Decision Records
```

### Analyze Options

```bash
openlore analyze [options]
  --output <path>        # Output directory (default: .openlore/analysis/)
  --max-files <n>        # Max files (default: 500)
  --include <glob>       # Additional include patterns
  --exclude <glob>       # Additional exclude patterns
  --force                # Force re-analysis (bypass 1-hour cache)
  --ai-configs           # Generate AI tool config files (CLAUDE.md, .cursorrules, .clinerules/openlore.md,
                         #   .github/copilot-instructions.md, .windsurf/rules.md, .vibe/skills/openlore.md)
                         #   Safe to re-run — skips files that already exist, marks pre-existing ones.
  --no-embed             # Skip building the semantic vector index (index is built by default when embedding is configured)
  --reindex-specs        # Re-index OpenSpec specs into the vector index without re-running full analysis
```

### Prove Options

```bash
openlore prove [options]
  --directory <path>     # Repo to measure (default: current directory)
  --runs <n>             # Runs per arm per task (default: 2; non-numeric is rejected)
  --model <name>         # Agent model (default: sonnet)
  --max-budget-usd <n>   # Per-agent-call USD ceiling (default: 0.5; non-numeric is rejected)
  --estimate             # Deterministic, no-agent, no-API projection of the orientation tax
  --dry-run              # Synthetic numbers (no agent, no API key)
  --json                 # Stable schemaVersion:1 scorecard on stdout (mutually exclusive with --markdown)
  --markdown             # Paste-ready scorecard block + shields.io badge (mutually exclusive with --json)
  --save                 # Persist a dated, non-clobbering scorecard under .openlore/prove/
```

The measured arm needs `claude` + an API key; `--estimate` and `--dry-run` need neither. A measured
run whose agent calls all fail **exits non-zero** rather than emitting a verdict over no data. The
`--json` shape is documented in [AGENT-BENCHMARKS.md](AGENT-BENCHMARKS.md#json-output-schema-for-ci).

### Setup Options

```bash
openlore setup [options]
  --tools <list>   Comma-separated tools to install: vibe, cline, claude, opencode, gsd, bmad, omoa (default: interactive prompt)
  --force          Overwrite existing files (use after upgrading openlore)
  --dir <path>     Project root directory (default: current directory)
```

Installs workflow skills from the openlore package into the project. Skills are static assets — identical across projects — so this command only needs to be run once at project onboarding and again after upgrading openlore.

Files installed:

| Tool | Destination | Content |
|------|-------------|---------|
| `vibe` | `.vibe/skills/openlore-{name}/SKILL.md` | 8 skills |
| `cline` | `.clinerules/workflows/openlore-{name}.md` | 7 workflows |
| `claude` | `.claude/skills/openlore-{name}/SKILL.md` + decisions pre-commit hook | 8 skills + commit gate |
| `opencode` | `.opencode/skills/openlore-{name}/SKILL.md` + `.opencode/plugins/agent-guard.ts` | 8 skills + guard plugin |
| `gsd` | `.claude/commands/gsd/openlore-{name}.md` | 2 commands |
| `bmad` | `_bmad/openlore/{agents,tasks}/` | 2 agents, 4 tasks |
| `omoa` | `.opencode/plugins/` + `.opencode/prompts/` | 4 SDD plugins + Sisyphus prompt (oh-my-openagent) |

The `omoa` option is **auto-detected and pre-checked** in the interactive prompt when oh-my-openagent is found in the project or user config.

Never overwrites existing files. Combine with `analyze --ai-configs` for a complete agent setup:

```bash
openlore analyze --ai-configs   # project-specific context files
openlore setup                   # workflow skills
```

### Decisions Options

```bash
openlore decisions [options]
  --list                 # List decisions, optionally filtered by --status
  --status <status>      # Filter by status: draft, consolidated, verified, approved, synced, phantom
                         # Note: synced/rejected/phantom are purged from store after --sync
  --approve <id>         # Approve a decision by ID (blocked if already synced)
  --reject <id>          # Reject a decision by ID
  --reason <text>        # Rejection reason (used with --reject)
  --sync                 # Write approved decisions into specs and ADRs, then purge inactive entries
  --dry-run              # Preview sync without writing files
  --gate                 # Run commit gate check (reads pending.json, no LLM — used by pre-commit hook)
                         # Gate reason codes: verified | approved_not_synced |
                         #   drafts_pending_consolidation | no_decisions_recorded
  --consolidate          # Manually trigger LLM consolidation + diff verification of drafts
  --json                 # Machine-readable output
  --uninstall-hook       # Remove decisions pre-commit hook (install via: openlore setup --tools claude)
```

### Verify Options

```bash
openlore verify [options]
  --samples <n>          # Files to verify (default: 5)
  --threshold <0-1>      # Minimum score to pass (default: 0.7)
  --files <paths>        # Specific files to verify
  --domains <list>       # Only verify specific domains
  --verbose              # Show detailed prediction vs actual comparison
  --json                 # JSON output
```

### Doctor

`openlore doctor` runs a self-diagnostic and surfaces actionable fixes when something is misconfigured or missing:

```bash
openlore doctor          # Run all checks
openlore doctor --json   # JSON output for scripting
```

Checks performed:

| Check | What it looks for |
|-------|------------------|
| Node.js version | ≥ 20 required |
| Git repository | `.git` directory and `git` binary on PATH |
| openlore config | `.openlore/config.json` exists and is parseable |
| Analysis artifacts | `repo-structure.json` freshness (warns if >24h old) |
| OpenSpec directory | `openspec/specs/` exists |
| LLM provider | API key or `claude` CLI detected |
| Disk space | Warns < 500 MB, fails < 200 MB |

Run `openlore doctor` whenever setup instructions aren't working — it tells you exactly what to fix and how.

### Federation (multi-repo)

Federation is an **index-of-indexes**: each repo keeps its own independently-built `.openlore` index, and a project-local registry (`.openlore/federation.json`) references them. Adding or removing a repo edits only the registry plus that repo's own build — never a global rebuild. No merged cross-repo graph is ever materialized; federated queries load only the per-repo indexes they need, on demand.

```bash
openlore federation add <path> [--name <name>]   # Register a repo (default name: its basename)
openlore federation remove <nameOrPath>          # alias: rm
openlore federation list                          # alias: ls — shows each repo's index state
```

Index state per repo: `✓ indexed`, `⚠ stale` (re-run `openlore analyze` there), `∅ unindexed`, or `✗ missing path`. Once a repo is registered, the four cross-repo conclusion tools — `analyze_impact`, `find_dead_code`, `select_tests`, `find_path` — accept an opt-in `federation` (or `federationRepos`) flag and report which repos were consulted vs skipped. The registry-status tool `federation_status` is exposed only under `openlore mcp --preset federation`. See [docs/federation.md](federation.md).

#### Spec-store binding

A **spec-store binding** points OpenLore at an external spec repository (one that holds specs/changes) and declares the code repositories its plans `targets` and `references`. The declared names resolve against the federation registry above. Configure it in `.openlore/config.json` (see [Configuration](configuration.md#spec-store-binding)), then check its health:

```bash
openlore spec-store status            # human-readable: per-target resolution + index state, references, store path
openlore spec-store status --json     # stable finding codes for an orchestrator (see docs/mcp-tools.md)
```

Read-only and advisory — it reports binding health and always exits 0; it never blocks. Findings carry stable codes (`target-unresolved`, `index-stale`, `reference-missing`, `registry-unreadable`, …) each with a pasteable remediation. The matching MCP tool `spec_store_status` is exposed under `openlore mcp --preset federation`.

#### Working-set context

Once a binding is sound, assemble the structural briefing an active change actually needs — `orient`, generalized from one repo to the change's targets:

```bash
openlore working-set context --change <id>                  # human-readable: per-target items, callers, anchored intent
openlore working-set context --change <id> --json           # documented JSON for an orchestrator to splice into its agent brief
openlore working-set context --change <id> --token-budget 4000   # cap the merged briefing
```

It reads the change's proposal under the bound store, orients each resolved+indexed target on that intent, and returns one budgeted, per-target-attributed briefing plus fresh in-scope anchored intent (orphaned withheld, drifted flagged). Read-only and advisory — always exits 0, never blocks. Findings carry stable codes (`change-not-found`, `target-not-briefable`, `no-briefable-targets`, …). The matching MCP tool `working_set_context` is exposed under `openlore mcp --preset federation`.

#### Change impact certificate

Certify what the current diff touches — and, crucially, what it *newly reaches* — before it lands. You declare **covering surfaces** (semantic/governance boundaries) under `impactCertificate.surfaces` in `.openlore/config.json`; the certificate reports the paths the change opens into each surface (reachable after the diff but not before), plus blast radius, drifted specs, and tests to run:

```bash
openlore impact-certificate                       # human-readable certificate for the working tree vs HEAD
openlore impact-certificate --base main --json    # documented JSON (stable surface + path codes) for an orchestrator
openlore impact-certificate --change <id> --save  # record the change id + persist for later decay re-checks
openlore impact-certificate --install-hook        # install the ADVISORY pre-commit hook (never blocks by default)
openlore impact-certificate --uninstall-hook      # remove the pre-commit hook block (coexists with other openlore hooks)
```

Advisory by default — it emits the certificate and exits 0; an infrastructure failure (no index, not a repo) never blocks. A repository MAY opt into blocking specific surface severities with `impactCertificate.block: ["critical"]`, in which case the `--hook` exits non-zero only when the diff opens a new path into a surface of that severity. Newly-opened-path detection is differential and deterministic (no LLM): only the changed files are re-parsed, renamed files read their base-ref content, untracked files are folded in, and an ambiguous added callee is reported, never guessed. The certificate decays via the freshness lease — when an anchored symbol later moves, `openlore spec-store status` re-fires it as a `certificate-stale` finding. The matching MCP tool `change_impact_certificate` is exposed under `openlore mcp --preset federation`.

#### Enforcement gate

`openlore enforce` is the **unified** finding-enforcement gate. It collects governance findings from every in-scope source, resolves each finding's enforcement class through the single declared [`enforcement.policy`](configuration.md#enforcement-policy) (with the legacy `blastRadius.block` / `impactCertificate.block` sugar lowered onto it), and — in `--hook` mode — fails the commit only when at least one finding resolves to `blocking`:

```bash
openlore enforce                 # human-readable gate report for the working tree (advisory)
openlore enforce --json          # documented JSON: gated, blocking[], advisory[], off[], unknownPolicyCodes[]
openlore enforce --hook          # hook mode: stderr + exit 1 only on a blocking-classed finding
openlore enforce --install-hook  # install the unified pre-commit hook (coexists with the decisions gate)
openlore enforce --uninstall-hook
```

Sources: the **stale-decision-reference** check always runs (a cheap walk of the decision graph + anchored references — it flags a live, authoritative artifact that still cites a superseded decision); the **blast-radius** orphan patterns and **impact-certificate** surfaces are collected only when the repository has configured them (those analyses are diff-heavy). Every source is advisory-safe — a throw degrades to a caveat and never blocks. Advisory by default: a repository that declares no `enforcement.policy` never blocks, and an `off`-classed finding is still listed (silenced, not invisible). Deterministic, no LLM. This gate is the recommended single posture; the per-surface `blast-radius --hook` / `impact-certificate --hook` remain for repositories that prefer one source per hook.

---

## OpenSpec plugin manifest

`openlore plugin-manifest` inspects and validates the OpenSpec **plugin** manifest
OpenLore publishes — the `"openspec"` key in its `package.json` — so the OpenSpec
marketplace can discover, surface, gate, and invoke OpenLore as a subprocess
without importing its code. It is **distinct** from `openlore manifest` (the
federation `.well-known/openlore.json`); the names never collide.

```bash
openlore plugin-manifest emit            # human-readable summary
openlore plugin-manifest emit --json     # the manifest as JSON, stdout only
openlore plugin-manifest validate        # schema + semantic check of OpenLore's own manifest
openlore plugin-manifest validate <dir>  # validate another package's manifest
```

`validate` exits `0` when the manifest is valid, `1` on a schema/semantic failure
(missing required field, no `bin`/`binArgs`, non-token `namespace`, a traversing
skill `dir`/`source`), and `2` when no manifest is found. The manifest declares the
namespace (`lore`), the executable (`bin: openlore`), `openspecCompat` (kept
coherent with the `@fission-ai/openspec` peer-dep range), the help-only surfaced
commands, the contributed skill, and `ownsConfigKeys: ["openlore"]`. See
[OPENSPEC-INTEGRATION.md](OPENSPEC-INTEGRATION.md) for the full marketplace contract.

> **Node-version guard.** OpenLore requires Node ≥22.5. The CLI checks this before
> any command runs; under an older Node it prints one stderr line naming the
> required and actual versions and exits with the stable code **78** — never a
> stack trace — so a host delegating to OpenLore (e.g. `openspec lore generate` on
> Node 20) surfaces a clean, legible failure.

---

## Serve (warm daemon)

`openlore serve` runs a long-lived loopback HTTP daemon that keeps openlore's
caches warm across calls and, with `--watch` (default), keeps the analysis
continuously fresh — signatures/vector live, plus a debounced full call-graph
re-analyze after each edit burst. It exposes the same tools as the MCP server
over plain HTTP so non-MCP clients (e.g. the [Pi](https://pi.dev) extension in
`examples/pi/`) can hit them with `fetch` — no JSON-RPC, no subprocess-per-call.

```bash
openlore serve                          # navigation preset, ephemeral port, watch on
openlore serve --preset all --port 7077 # all 62 tools on a fixed port
openlore serve --no-watch               # transport only, no freshness lane
openlore serve --stop                   # stop the daemon serving this directory
```

| Option | Description |
|--------|-------------|
| `-d, --directory <path>` | Project root to serve; discovery file written here (default: cwd) |
| `-p, --port <number>` | Port to bind (default: ephemeral free port) |
| `--host <host>` | Host to bind (default: `127.0.0.1`) |
| `--preset <name>` | Advisory surface reported by `/health`: `minimal`, `navigation` (default), or `all`/`full` (the full surface — `full` matches the `openlore mcp` selector name). The daemon dispatches any known tool regardless; clients curate their own surface |
| `--token <token>` | Require this token as the `x-openlore-token` header (default: `$OPENLORE_SERVE_TOKEN`) |
| `--no-watch` | Disable the freshness watcher + re-analyze lane |
| `--stop` | Stop a running daemon for `--directory` and exit |

Endpoints (loopback only): `GET /health`, `POST /tool/:name` with body
`{ "directory": "...", "args": { ... } }`. Discovery: the daemon writes
`.openlore/serve.json` `{ port, pid, host, token? }` (removed on clean shutdown).

```bash
PORT=$(jq .port .openlore/serve.json)
curl 127.0.0.1:$PORT/health
curl -XPOST 127.0.0.1:$PORT/tool/orient -d '{"args":{"task":"add rate limiting"}}'
```

### Pi integration

`openlore setup --tools pi` installs the Pi extension to `.pi/extensions/openlore.ts`
(add `--global` for `~/.pi/agent/extensions/`). It auto-starts and talks to the
serve daemon, injecting structural context and exposing the navigation tools.
See `examples/pi/README.md`.

---

## Developer Scripts

| Script | Description |
|--------|-------------|
| `npm run bench` | EdgeStore micro-benchmark (node lookup, BFS, orient path) — requires `openlore analyze` |
| `npm run bench:mcp` | MCP handler benchmark — measures cold vs warm path for `readCachedContext`, `handleOrient`, `handleSearchCode`. Requires `openlore analyze`. Pass a project dir: `npm run bench:mcp -- /path/to/project` |


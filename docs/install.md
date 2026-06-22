# `openlore install`

Auto-configure popular AI coding agents to call OpenLore's `orient()` automatically.

## Quick start

```bash
cd your-project
openlore install
```

That auto-detects which agent surfaces are present (Claude Code, Cursor, Cline, Continue, plus
the universal `AGENTS.md` fallback) and writes the minimal config needed for each agent to call
`orient()` before reading source files.

## Flags

| Flag | Effect |
|------|--------|
| `--agent <name>` | Install only for one surface. Names: `claude-code`, `cursor`, `cline`, `continue`, `agents-md`. |
| `--preset <name>` | Wire the MCP server to a tool preset: `navigation` (the lean default), `minimal`, `memory`, `verify`, `federation`, or `full`. Omit it for the lean navigation surface; pass `--preset full` to wire all 62 tools (the prior default). |
| `--dry-run` | Print the planned changes; write nothing. |
| `--force` | Overwrite OpenLore-managed blocks even when hand-edited. |
| `--uninstall` | Remove every OpenLore-managed block / entry. Files OpenLore created (and never had non-OpenLore content) are deleted. |

> **Default tool surface (since `default-to-lean-tool-surface`).** A plain `openlore install` wires the
> MCP server to the lean **`navigation`** preset — 10 graph-traversal tools, the Spec 14 benchmark
> winner — not all 62. This is per-session token savings with no capability loss: every tool stays one
> opt-in away. Note the lean default does **not** include the governance tools the decisions pre-commit
> gate uses (`record_decision`, `check_spec_drift`, `detect_changes`); on a repo that gates commits,
> install with **`--preset full`** (all 62) or **`--preset minimal`** (the governance core) to wire them.

## What it actually writes

Every file we touch gets a managed block delimited by:

```
<!-- BEGIN OPENLORE (managed — edits inside this block will be overwritten) -->
<!-- openlore-fingerprint: <16-hex> -->
...content...
<!-- END OPENLORE -->
```

JSON config files get a top-level `_openlore` key carrying a fingerprint of the values we wrote.
Re-running `openlore install` is a no-op when the fingerprint matches; if you hand-edited inside
the block we refuse to overwrite unless you pass `--force`.

| Surface | Marker | Files written |
|---------|--------|---------------|
| `claude-code` | `.claude/` or `CLAUDE.md` | append block to `CLAUDE.md`; `mcpServers.openlore` + `SessionStart` hook in `.claude/settings.json` |
| `cursor` | `.cursor/` or `.cursorrules` | append block to `.cursorrules`; write `.cursor/rules/openlore.mdc`; `mcpServers.openlore` in `.cursor/mcp.json` |
| `cline` | `.clinerules` or `.vscode/settings.json` (`cline.*`) | append block to `.clinerules` |
| `continue` | `.continue/` | add `/orient` entry to `.continue/config.json` (MCP server registration is TODO — see below) |
| `agents-md` | always applies | append block to `AGENTS.md` (creates if absent) |

## Known follow-ups

- **Continue MCP registration**: Continue's MCP config path varies across recent versions, so
  we currently only register the `/orient` slash command and leave a warning. See
  `TODO(openlore-spec-01)` in `src/cli/install/adapters/continue.ts`.

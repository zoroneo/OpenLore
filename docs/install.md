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
| `--dry-run` | Print the planned changes; write nothing. |
| `--force` | Overwrite OpenLore-managed blocks even when hand-edited. |
| `--uninstall` | Remove every OpenLore-managed block / entry. Files OpenLore created (and never had non-OpenLore content) are deleted. |

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
| `claude-code` | `.claude/` or `CLAUDE.md` | append block to `CLAUDE.md`; `mcpServers.openlore` in `.mcp.json`; `SessionStart` + `UserPromptSubmit` hooks in `.claude/settings.json` |
| `cursor` | `.cursor/` or `.cursorrules` | append block to `.cursorrules`; write `.cursor/rules/openlore.mdc`; `mcpServers.openlore` in `.cursor/mcp.json` |
| `cline` | `.clinerules` or `.vscode/settings.json` (`cline.*`) | append block to `.clinerules` |
| `continue` | `.continue/` | add `/orient` entry to `.continue/config.json` (MCP server registration is TODO — see below) |
| `agents-md` | always applies | append block to `AGENTS.md` (creates if absent) |

## Task-scoped context injection

Beyond the whole-repo `SessionStart` primer, `openlore install` wires a **per-task** injection
hook (Claude Code `UserPromptSubmit`) that runs `openlore orient --inject` against your submitted
prompt and places a compact orientation block in context **before the agent's first turn**. The
orientation the agent would otherwise spend a tool round-trip to fetch is simply already there —
the round-trip is amortized to zero, which is the cost OpenLore's
[Value Scorecard](AGENT-BENCHMARKS.md) attributes the small/familiar/shallow loss case to.

The injected block:

- **reuses lean `orient` output** (Spec 27) — there is no second orientation code path;
- is **deterministic** (no LLM) and **bounded** by a token budget (default ~600 tokens), so it can
  never dominate the context it economizes;
- is **clearly attributed to OpenLore** and opens with a one-line "informational; act on it or
  ignore it" framing — facts, not instructions;
- is **gated**: a deterministic graph-relevance signal (matched-function count, fan-in, match
  score) decides whether the task warrants a full block; below the threshold it degrades to a
  single pointer line, so injection stays out of the small/familiar arena it would otherwise tax;
- **never breaks your turn**: any failure (no graph, parse error, empty/weak match) degrades to the
  pointer line and exits 0.

### Per-adapter support

| Surface | Pre-turn injection channel |
|---------|----------------------------|
| `claude-code` | ✅ `UserPromptSubmit` hook running `openlore orient --inject` |
| `cursor`, `cline`, `continue`, `agents-md` | ❌ no pre-turn hook mechanism — these fall back to the instruction block + `SessionStart`-style guidance; no behavior change |

### Turning it off

Task-scoped injection is on by default. To disable it (while leaving the MCP server and the
`SessionStart` primer intact), set in `.openlore/config.json`:

```jsonc
{
  "contextInjection": {
    "mode": "off",            // "task-scoped" (default) | "off"
    "tokenBudget": 600,        // hard cap on the injected block, in estimated tokens
    "relevanceMinMatches": 2,  // gate: minimum matched-function count
    "relevanceMinFanIn": 2,    // gate: a match this central (or a hub) clears the gate
    "relevanceMinScore": 0.3   // gate: minimum top score (semantic/hybrid scale only)
  }
}
```

With `mode: "off"`, `openlore orient --inject` emits nothing and exits 0.

## Known follow-ups

- **Continue MCP registration**: Continue's MCP config path varies across recent versions, so
  we currently only register the `/orient` slash command and leave a warning. See
  `TODO(openlore-spec-01)` in `src/cli/install/adapters/continue.ts`.

---
name: openlore-orient
version: 2.0
description: Persistent architectural memory for this codebase. Call `orient(task)` before reading source files to get the relevant functions, callers, spec sections, and insertion points for any task — saving 15,000–50,000 tokens of file-by-file rediscovery.
---

# OpenLore — orient before you read

This project uses **OpenLore** to maintain a deterministic, graph-native model of the codebase: every function, every caller, every spec section, every file. The `orient` tool collapses what would otherwise be a chain of `analyze_codebase → search_code → search_specs → suggest_insertion_points` into a single call.

The single most important habit when working in this repo: **call `orient` before opening source files for any non-trivial task.**

## When to use this skill

Call `orient` at the start of any of these:

- **New task in the repo** — even ones that feel small. The graph knows things the file tree doesn't.
- **Unknown function or symbol** — instead of grepping blind, ask `orient` and let it return the function, its callers, and the spec section that owns it.
- **Planning a cross-module change** — `orient` returns insertion points ranked by structural fit, so you start at the right boundary instead of the most-recently-viewed file.
- **After an Epistemic Lease prefix appears** — when a tool response says you're stale, re-orient before continuing. Acting on stale context is the most common failure mode.

If you are reading source files without having called `orient` first, you are probably wasting tokens.

## How to use it

### Preferred: via the OpenLore MCP server

If `openlore` is registered as an MCP server in this project (look for `.claude/settings.json` → `mcpServers.openlore`), call the `orient` tool directly through the MCP interface. This is the lowest-latency path and gives the model access to the full openlore tool surface (45 tools), not just `orient`.

### Fallback: via the shell wrapper

```sh
bash scripts/orient.sh "<task description>"
```

(On Windows: `powershell -File scripts/orient.ps1 "<task description>"`)

The wrapper tries the direct CLI subcommand first (`npx --yes openlore orient --json --task "<task>"`) and falls back to driving the `openlore mcp` server over stdio JSON-RPC via the sibling `orient-via-mcp.mjs` helper when the CLI subcommand isn't shipped yet. Either path produces real orient JSON on stdout. Parse these arrays from the result:

- **`relevant_functions`** — top scored functions for the task, with file/line, role classification, and a short reason.
- **`callers`** — depth-1 caller neighbourhood for each top function. This is where "who breaks if I change this" lives.
- **`spec_sections`** — OpenSpec sections that own the relevant files, including the requirements they encode. Read these before reading code.
- **`insertion_points`** — ranked candidate locations to make the change, with structural justification.

Always start by reading **`spec_sections`**, then **`callers`**, then jump into source only at the **`insertion_points`** you actually plan to edit.

> **TODO(spec-02-followup):** the `openlore orient` CLI subcommand (with `--task`) is not yet shipped on the npm package — the wrappers reach the `orient` tool through the MCP server as a fallback. A future spec will add the CLI subcommand and the wrappers will pick it up automatically.

## What NOT to do

- **Do not open source files before `orient` has returned.** This is the single most expensive mistake — you'll re-derive what the graph already knows.
- **Do not call `orient` on every edit.** It's a session-start and re-orient-on-staleness tool, not a per-call helper. Respect the Epistemic Lease signal — if no prefix appears, your context is still fresh.
- **Do not paraphrase the task** when passing it to `orient`. Use the user's words. The semantic search matches better when the query language matches the eventual prompt.
- **Do not ignore `spec_sections`.** Reading specs first is faster and more accurate than reading code first, in this repo.

## Cost & latency

Typical `orient()` against a warm graph in this repo:

| Measurement | Value |
|---|---|
| Wall time | < 500 ms |
| Output size | ~1–3k tokens of JSON |
| Tokens saved vs. file-by-file rediscovery | 15,000–50,000 |
| Network calls | 0 (all local — no LLM, no API key required) |

Cold-graph first call may take 2–4s if the on-disk index needs to be loaded; subsequent calls in the same session hit the in-memory cache. See the [main README benchmarks](../../README.md) for the published numbers.

## Failure modes

If `orient` returns an empty result or errors:

1. **Empty `relevant_functions` array** — the task description didn't match the graph. Try rephrasing using a known module name, function name, or domain word from the spec. Do not fall back silently — tell the user that `orient` didn't match and you're going to grep.
2. **Wrapper output contains `"error": "No analysis found"`** — the codebase hasn't been analyzed yet. Run `npx openlore analyze` once to seed the graph, then retry. The wrapper itself is healthy in this case; the underlying tool is telling you what's missing.
3. **Graph is stale (mtime older than recent edits)** — the JSON output will still come back, but the insertion points may be wrong. Re-run `npx openlore analyze` to rebuild.

In all failure cases, the correct fallback is a *targeted* `grep`/file read scoped to a single module — not opening the whole repo. And **always tell the user the skill silently degraded** so they can rebuild the graph if needed.

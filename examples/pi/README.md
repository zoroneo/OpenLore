# openlore × Pi

A [Pi](https://pi.dev) extension that brings openlore's deterministic structural
context into Pi — built for local models (Qwen, Gemma, …) that are strong at
using injected context but weaker at tool-calling.

It does **not** use MCP. It talks to a warm `openlore serve` HTTP daemon over
loopback, so tool calls hit warm caches and the analysis stays continuously
fresh while you edit.

## What you get

- **Context injection** (no tool call needed): each session starts grounded with
  the architecture digest (`CODEBASE.md`), the spec-domain index, and a
  task-specific `orient` on your first message.
- **Native tools**: the navigation surface as Pi tools —
  `openlore_orient`, `openlore_search_code`, `openlore_get_subgraph`,
  `openlore_trace_execution_path`, `openlore_analyze_impact`,
  `openlore_suggest_insertion_points`, `openlore_get_function_skeleton`.

## Prerequisites

```bash
npm i -g openlore         # `openlore` must be on PATH
cd your-project
openlore analyze          # build the structural index at least once
```

## Install

Automatic:

```bash
openlore setup --tools pi            # → .pi/extensions/openlore.ts (this project)
openlore setup --tools pi --global   # → ~/.pi/agent/extensions/openlore.ts (all projects)
```

Manual: copy `openlore.ts` into either location.

> Imports are verified against pi 0.78 (`Type` from `typebox`, `StringEnum` from
> `@earendil-works/pi-ai`, extension types from `@earendil-works/pi-coding-agent`).
> If a future Pi version moves these, adjust the imports at the top of `openlore.ts`.

## How it works

On first use the extension looks for `.openlore/serve.json`; if no healthy daemon
is announced it spawns `openlore serve` detached and waits for `/health`.
The daemon:

- serves the `navigation` tool preset over `127.0.0.1`,
- keeps signatures/vector fresh live, and
- re-analyzes the call graph (debounced) after each edit burst — so what the
  model sees never silently diverges from the code.

The extension never kills a daemon it didn't start; it may be serving other
clients (another Pi session, an editor).

## Verify

```bash
# daemon is reachable
curl 127.0.0.1:$(jq .port .openlore/serve.json)/health

# a tool round-trips
curl -XPOST 127.0.0.1:$(jq .port .openlore/serve.json)/tool/orient \
  -d '{"args":{"task":"add rate limiting"}}'
```

Then run Pi in the project and confirm the session opens with openlore context
and that `openlore_orient` is callable.

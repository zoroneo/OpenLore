#!/usr/bin/env sh
# Wrapper: ask `openlore orient` for the relevant functions/callers/specs/
# insertion-points for a task, and print the JSON to stdout.
#
# Strategy (in order):
#   1. `npx --yes openlore orient --json --task "<task>"` — preferred path,
#      activates as soon as the orient CLI subcommand is shipped (TODO below).
#   2. Drive the existing `openlore mcp` server over stdio JSON-RPC via the
#      sibling orient-via-mcp.mjs helper — works today against the current
#      shipped surface.
#
# TODO(spec-02-followup): once the `openlore orient --json --task` CLI
# subcommand lands on the npm package, path #2 becomes unnecessary. The
# wrapper picks #1 automatically.
set -eu
TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "usage: orient.sh \"<task description>\"" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Preferred path: direct CLI subcommand (if/when it ships). Detect by
# inspecting `openlore --help` output — commander returns exit 0 even for
# unknown subcommands, so we can't rely on `orient --help`'s exit code.
if npx --yes openlore --help 2>/dev/null | grep -Eq '^  orient( |$|\[)'; then
  exec npx --yes openlore orient --json --task "$TASK"
fi

# Fallback path: drive the MCP server over stdio JSON-RPC.
exec node "$SCRIPT_DIR/orient-via-mcp.mjs" "$TASK"

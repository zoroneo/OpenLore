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

param(
  [Parameter(Mandatory=$false, Position=0)]
  [string]$Task
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Task)) {
  [Console]::Error.WriteLine('usage: orient.ps1 "<task description>"')
  exit 2
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Preferred path: direct CLI subcommand (if/when it ships). Detect by
# scanning `openlore --help` — commander returns exit 0 even for unknown
# subcommands, so we can't rely on `orient --help`'s exit code.
$help = & npx --yes openlore --help 2>$null
if ($help -match '(?m)^  orient( |$|\[)') {
  & npx --yes openlore orient --json --task $Task
  exit $LASTEXITCODE
}

# Fallback path: drive the MCP server over stdio JSON-RPC.
& node (Join-Path $ScriptDir 'orient-via-mcp.mjs') $Task
exit $LASTEXITCODE

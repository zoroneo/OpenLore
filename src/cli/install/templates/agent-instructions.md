This project uses OpenLore for persistent architectural memory.

ALWAYS call `orient()` (via the openlore MCP server, or `npx openlore orient --json`)
before reading source files when starting a new task. This returns the relevant
functions, callers, spec sections, and insertion points for the task at hand —
one structural lookup instead of file-by-file rediscovery.

Re-orient whenever the Epistemic Lease indicates staleness (you'll see a prefix
on tool responses telling you to do so).

For the MCP setup, ensure `openlore mcp` is configured as an MCP server.
See https://github.com/clay-good/OpenLore for details.

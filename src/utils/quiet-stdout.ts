/**
 * Stdout discipline for machine-readable (`--json`) command modes.
 *
 * Surfaced OpenLore subcommands are spawned by OpenSpec as child processes; a
 * consumer parsing stdout must never get log noise mixed in. The logger routes
 * info/success/discovery/warning to stdout via console.log, so in `--json` mode any
 * such line would corrupt the JSON. These helpers redirect console.log/info/warn to
 * stderr for the duration of the work, leaving process.stdout.write (used to emit
 * the JSON) clean. The MCP server applies the same discipline; logger.error already
 * uses stderr.
 */

/**
 * Redirect console.log/info/warn to stderr. Returns a restore function — call it in
 * a `finally` so the originals are always reinstated, even on error.
 */
export function redirectConsoleToStderr(): () => void {
  const orig = { log: console.log, info: console.info, warn: console.warn };
  const toStderr = (...args: unknown[]): void => {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  return () => {
    console.log = orig.log;
    console.info = orig.info;
    console.warn = orig.warn;
  };
}

/** Run `fn` with console.log/info/warn redirected to stderr, then restore them. */
export async function withQuietStdout<T>(fn: () => Promise<T>): Promise<T> {
  const restore = redirectConsoleToStderr();
  try {
    return await fn();
  } finally {
    restore();
  }
}

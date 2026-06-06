/**
 * openlore serve — local HTTP daemon (warm, loopback-only).
 *
 * A long-lived process that keeps openlore's caches warm across calls and
 * exposes the tool surface over plain HTTP so non-MCP clients (e.g. a Pi
 * extension) can hit it with `fetch` — no JSON-RPC, no subprocess-per-call.
 *
 * It reuses the SAME tool dispatch as the stdio MCP server
 * ({@link dispatchTool}) so the two transports can't drift, and the SAME tool
 * presets ({@link selectActiveTools}) so a small-model client gets a focused
 * surface (default: `navigation`).
 *
 * Endpoints (all loopback):
 *   GET  /health           → { ok, version, root, preset, tools, uptimeMs }
 *   POST /tool/:name       body { directory?, args }  → handler result (JSON)
 *
 * Discovery: writes `.openlore/serve.json` { port, pid, host, token?, startedAt }
 * in the served root so a client can find and reuse a running daemon.
 *
 * Security: binds 127.0.0.1 only. An optional --token must be presented as the
 * `x-openlore-token` header, keeping other local users off the port.
 *
 * Freshness (watcher + continuous re-analyze) is layered on separately; this
 * module is the transport + lifecycle core.
 */

import { Command } from 'commander';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { writeFile, readFile, unlink, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { logger } from '../../utils/logger.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { dispatchTool, UnknownToolError } from '../../core/services/tool-dispatch.js';
import { validateDirectory, waitForGraphRebuild } from '../../core/services/mcp-handlers/utils.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { McpWatcher } from '../../core/services/mcp-watcher.js';
import { openloreAnalyze } from '../../api/analyze.js';
import { TOOL_DEFINITIONS, TOOL_PRESETS, selectActiveTools } from './mcp.js';

/**
 * Debounce before a full call-graph re-analyze after edits settle. Longer than
 * the watcher's signature debounce (WATCH_DEBOUNCE_MS=400) because re-analysis
 * is heavier; a few seconds of quiet is the signal that an edit burst is done.
 */
const REANALYZE_DEBOUNCE_MS = 4000;

const _require = createRequire(import.meta.url);
const _pkgVersion = (_require('../../../package.json') as { version: string }).version;

/** Daemon discovery descriptor written to <root>/.openlore/serve.json. */
interface ServeDescriptor {
  port: number;
  pid: number;
  host: string;
  token?: string;
  startedAt: string;
  version: string;
}

interface ServeCliOptions {
  directory?: string;
  port?: string;
  host?: string;
  preset?: string;
  token?: string;
  stop?: boolean;
  /** false (via --no-watch) disables the freshness watcher + re-analyze lane. */
  watch?: boolean;
}

/** Live daemon handle. Returned by {@link startServe} so callers (tests) can
 * address and shut down the running server without signalling the process. */
export interface ServeHandle {
  port: number;
  host: string;
  token?: string;
  baseUrl: string;
  close(): Promise<void>;
}

const SERVE_FILE = 'serve.json';
const MAX_BODY_BYTES = 1_000_000; // tool args are small; reject anything larger

function serveFilePath(root: string): string {
  return join(root, OPENLORE_DIR, SERVE_FILE);
}

/** Read a JSON request body with a hard size ceiling. Rejects on overflow/parse error. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve_, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) return resolve_({});
      try {
        resolve_(JSON.parse(raw) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** Read <root>/.openlore/serve.json if present. */
async function readDescriptor(root: string): Promise<ServeDescriptor | null> {
  try {
    return JSON.parse(await readFile(serveFilePath(root), 'utf-8')) as ServeDescriptor;
  } catch {
    return null;
  }
}

/**
 * Confirm a descriptor points at a LIVE openlore daemon — not a stale serve.json
 * left by a SIGKILL'd process, nor a recycled port now owned by something else.
 * Verifies GET /health returns our `ok: true` shape, so we never signal a PID we
 * can't positively identify as our own daemon.
 */
async function daemonAlive(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/** Stop a daemon previously started for `root` by signalling its recorded pid. */
async function stopDaemon(root: string): Promise<void> {
  const path = serveFilePath(root);
  const desc = await readDescriptor(root);
  if (!desc) {
    logger.warning(`No running openlore serve daemon found for ${root}.`);
    return;
  }
  // Only signal a PID we've confirmed is our live daemon on the recorded port.
  // A stale serve.json could otherwise point at a recycled PID belonging to an
  // unrelated process — SIGTERM to that would be a nasty surprise.
  if (!(await daemonAlive(desc))) {
    await unlink(path).catch(() => {});
    logger.warning(`No live daemon at ${desc.host}:${desc.port}; removed stale ${SERVE_FILE}.`);
    return;
  }
  try {
    process.kill(desc.pid, 'SIGTERM');
    logger.success(`Sent SIGTERM to openlore serve (pid ${desc.pid}).`);
  } catch {
    await unlink(path).catch(() => {});
    logger.warning(`Daemon pid ${desc.pid} not signalable; removed stale ${SERVE_FILE}.`);
  }
}

export async function startServe(options: ServeCliOptions): Promise<ServeHandle | undefined> {
  const root = resolve(options.directory ?? process.cwd());

  if (options.stop) {
    await stopDaemon(root);
    return undefined;
  }

  const host = options.host ?? '127.0.0.1';
  const presetName = options.preset ?? 'navigation';
  if (presetName !== 'all' && !TOOL_PRESETS[presetName]) {
    logger.error(`Unknown --preset "${presetName}". Known: ${Object.keys(TOOL_PRESETS).join(', ')}, all.`);
    process.exitCode = 1;
    return;
  }
  // Active tool surface: 'all' = every tool, otherwise the named preset.
  const activeNames = new Set(
    (presetName === 'all'
      ? TOOL_DEFINITIONS
      : selectActiveTools(TOOL_DEFINITIONS, { preset: presetName })
    ).map((t) => t.name),
  );

  // Don't start a second daemon for a root already served by a healthy one —
  // a concurrent spawn (two MCP clients, or pi + MCP) would otherwise leave two
  // watchers racing on the same .openlore/analysis. Reuse the live one instead.
  const existing = await readDescriptor(root);
  if (existing && (await daemonAlive(existing))) {
    logger.success(
      `openlore serve already running for ${root} at http://${existing.host}:${existing.port} — reusing.`,
    );
    return {
      port: existing.port,
      host: existing.host,
      token: existing.token,
      baseUrl: `http://${existing.host}:${existing.port}`,
      close: async () => {}, // never tear down a daemon this process didn't start
    };
  }

  const token = options.token ?? (process.env.OPENLORE_SERVE_TOKEN || undefined);
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Per-directory schema-reset flag. Set once (at startup or first request);
  // cleared after waitForGraphRebuild() succeeds so subsequent requests don't
  // re-open EdgeStore. Uses a Map because the daemon can serve multiple dirs.
  const schemaResetByDir = new Map<string, boolean>();

  const server = createServer((req, res) => {
    void handleRequest(req, res).catch((err) => {
      sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}`);

    // Token gate (skips /health so liveness checks need no secret).
    if (token && url.pathname !== '/health') {
      if (req.headers['x-openlore-token'] !== token) {
        sendJson(res, 401, { error: 'invalid or missing x-openlore-token' });
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        ok: true,
        version: _pkgVersion,
        root,
        preset: presetName,
        tools: [...activeNames],
        uptimeMs: Date.now() - startMs,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/tool/')) {
      const name = decodeURIComponent(url.pathname.slice('/tool/'.length));
      // The preset is ADVISORY (reported by /health for clients that want a
      // curated list, e.g. the Pi extension). The daemon dispatches any known
      // tool so it can back multiple clients with different surfaces — notably
      // the MCP server, which delegates all ~45 tools here. Unknown tools 404
      // via UnknownToolError below.
      let body: Record<string, unknown>;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'bad request' });
        return;
      }
      const args = (body.args as Record<string, unknown>) ?? {};
      // Directory precedence: explicit body.directory → args.directory → served root.
      const directory = (typeof body.directory === 'string' && body.directory)
        || (typeof args.directory === 'string' && args.directory)
        || root;
      // Ensure handlers receive directory in args (they read it from there).
      if (typeof args.directory !== 'string') args.directory = directory;

      try {
        await validateDirectory(directory);
      } catch (err) {
        sendJson(res, 400, { error: err instanceof Error ? err.message : 'invalid directory' });
        return;
      }

      // Auto-heal schema mismatch: on first request for a directory, open
      // EdgeStore once to detect wasReset; cache the result so we never
      // re-open on subsequent requests. If reset, block until rebuild done.
      if (!schemaResetByDir.has(directory)) {
        try {
          const analysisDir = join(directory, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
          if (EdgeStore.exists(analysisDir)) {
            const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
            schemaResetByDir.set(directory, es.wasReset);
            es.close();
          } else {
            schemaResetByDir.set(directory, false);
          }
        } catch {
          schemaResetByDir.set(directory, false);
        }
      }
      if (schemaResetByDir.get(directory)) {
        logger.debug(`[serve] Schema mismatch — waiting for graph rebuild before dispatching…`);
        // waitForGraphRebuild polls readCachedContext until edgeStore is
        // non-null. readCachedContext invalidates on llm-context.json mtime,
        // which openloreAnalyze rewrites as its last step — so the poll sees
        // the rebuilt state as soon as analyze completes.
        const rebuilt = await waitForGraphRebuild(directory, 60_000);
        schemaResetByDir.set(directory, !rebuilt);
        if (!rebuilt) logger.warning(`[serve] Graph rebuild timed out — graph tools may return empty results.`);
      }

      try {
        const result = await dispatchTool(name, args, directory);
        sendJson(res, 200, result ?? null);
      } catch (err) {
        if (err instanceof UnknownToolError) {
          sendJson(res, 404, { error: err.message });
          return;
        }
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    sendJson(res, 404, { error: `No route for ${req.method} ${url.pathname}` });
  }

  // Bind (port 0 → OS picks a free ephemeral port).
  const port = options.port ? parseInt(options.port, 10) : 0;
  await new Promise<void>((resolve_, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve_);
  });
  const addr = server.address();
  const boundPort = typeof addr === 'object' && addr ? addr.port : port;

  const descriptor: ServeDescriptor = {
    port: boundPort,
    pid: process.pid,
    host,
    token,
    startedAt,
    version: _pkgVersion,
  };
  await mkdir(join(root, OPENLORE_DIR), { recursive: true });
  await writeFile(serveFilePath(root), JSON.stringify(descriptor, null, 2) + '\n', 'utf-8');

  logger.success(`openlore serve listening on http://${host}:${boundPort} (preset: ${presetName})`);
  logger.discovery(`Discovery file: ${serveFilePath(root)}`);

  // Pre-populate the schema-reset flag for the served root so the startup
  // warning fires immediately and the first request doesn't pay the open cost.
  try {
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    if (EdgeStore.exists(analysisDir)) {
      const es = EdgeStore.open(EdgeStore.dbPath(analysisDir));
      const reset = es.wasReset;
      es.close();
      schemaResetByDir.set(root, reset);
      if (reset) {
        logger.warning(
          `[serve] Schema version mismatch detected — graph index is being rebuilt in the background. ` +
          `Graph-dependent tools will wait for completion on first request.`
        );
      }
    } else {
      schemaResetByDir.set(root, false);
    }
  } catch (err) {
    logger.debug(`[serve] Failed to check schema on startup: ${err instanceof Error ? err.message : String(err)}`);
    schemaResetByDir.set(root, false);
  }

  // ── Freshness: watcher (signatures + vector) + debounced call-graph re-analyze ──
  // The watcher keeps signatures/vector fresh between commits and primes the read
  // cache in place. Its onBatchFlushed hook schedules a heavier full re-analyze so
  // the CALL GRAPH (which the watcher deliberately skips) also stays fresh between
  // commits — turning divergence from "wait for the next commit" into continuous.
  let watcher: McpWatcher | undefined;
  let reanalyzeTimer: ReturnType<typeof setTimeout> | undefined;
  let reanalyzeRunning = false;
  let reanalyzePending = false;

  const runReanalyze = async (): Promise<void> => {
    if (reanalyzeRunning) { reanalyzePending = true; return; } // single-flight + coalesce
    reanalyzeRunning = true;
    try {
      await openloreAnalyze({ rootPath: root, force: true });
      logger.discovery(`[serve] call graph re-analyzed (${root})`);
    } catch (err) {
      logger.warning(`[serve] re-analyze failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      reanalyzeRunning = false;
      if (reanalyzePending) { reanalyzePending = false; scheduleReanalyze(); }
    }
  };
  function scheduleReanalyze(): void {
    if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
    reanalyzeTimer = setTimeout(() => void runReanalyze(), REANALYZE_DEBOUNCE_MS);
  }

  if (options.watch !== false) {
    watcher = new McpWatcher({ rootPath: root, onBatchFlushed: () => scheduleReanalyze() });
    try {
      await watcher.start();
      logger.discovery(`[serve] watching ${root} — signatures/vector live, call-graph re-analyze debounced`);
    } catch (err) {
      logger.warning(`[serve] watcher failed to start: ${err instanceof Error ? err.message : String(err)}`);
      watcher = undefined;
    }
  }

  // Clean shutdown: drop the descriptor so clients don't reuse a dead port.
  // Signal handlers exit the process; the returned close() is for in-process
  // callers (tests) that must not kill the host.
  // Store handler refs so teardown() can remove them — without this, every
  // startServe() call (including each test) adds permanent process listeners
  // that accumulate and trigger MaxListenersExceededWarning.
  let shuttingDown = false;
  const teardown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off('SIGINT',  onSigInt);
    process.off('SIGTERM', onSigTerm);
    if (reanalyzeTimer) clearTimeout(reanalyzeTimer);
    if (watcher) await watcher.stop().catch(() => {});
    await unlink(serveFilePath(root)).catch(() => {});
    await new Promise<void>((res) => server.close(() => res()));
  };
  const exitAfterTeardown = async (): Promise<void> => {
    await teardown();
    process.exit(0);
  };
  const onSigInt  = () => void exitAfterTeardown();
  const onSigTerm = () => void exitAfterTeardown();
  process.on('SIGINT',  onSigInt);
  process.on('SIGTERM', onSigTerm);

  return {
    port: boundPort,
    host,
    token,
    baseUrl: `http://${host}:${boundPort}`,
    close: teardown,
  };
}

export const serveCommand = new Command('serve')
  .description('Start a warm local HTTP daemon exposing openlore tools (loopback, for editor/agent integrations like Pi)')
  .option('-d, --directory <path>', 'Project root to serve (discovery file written here)', process.cwd())
  .option('-p, --port <number>', 'Port to bind (default: ephemeral free port)')
  .option('--host <host>', 'Host to bind', '127.0.0.1')
  .option(
    '--preset <name>',
    'Advisory tool surface reported by /health (minimal, navigation, or all). The daemon still ' +
      'dispatches any known tool; clients curate their own surface. Default: navigation',
    'navigation',
  )
  .option('--token <token>', 'Require this token as the x-openlore-token header (default: $OPENLORE_SERVE_TOKEN)')
  .option('--no-watch', 'Disable the freshness watcher + debounced call-graph re-analyze')
  .option('--stop', 'Stop a running daemon for --directory and exit')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore serve                          Warm daemon, navigation preset, ephemeral port
  $ openlore serve --preset all --port 7077 All tools on a fixed port
  $ openlore serve --stop                   Stop the daemon serving this directory

  $ curl 127.0.0.1:$PORT/health
  $ curl -XPOST 127.0.0.1:$PORT/tool/orient -d '{"args":{"task":"add rate limiting"}}'
`,
  )
  .action(async (options: ServeCliOptions) => {
    await startServe(options);
  });

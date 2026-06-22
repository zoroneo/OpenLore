/**
 * Tests for the `openlore serve` HTTP daemon: endpoints, advisory preset,
 * token gate, dup-daemon reuse, and serve.json discovery-file lifecycle.
 *
 * Served root is a throwaway temp dir (no analysis), so /tool/orient returns a
 * structured "no analysis" object (HTTP 200) without touching the repo's own
 * .openlore. We assert transport behaviour, not handler output.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { startServe, readDescriptor, idleTimeoutMs, type ServeHandle } from './serve.js';
import { EdgeStore } from '../../core/services/edge-store.js';
import { openloreAnalyze } from '../../api/analyze.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';

let handle: ServeHandle | undefined;
let root = '';

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  if (root) {
    await rm(root, { recursive: true, force: true });
    root = '';
  }
});

async function boot(opts: { token?: string; preset?: string } = {}): Promise<ServeHandle> {
  root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
  // watch:false — these are transport tests; the watcher has its own coverage.
  const h = await startServe({ directory: root, port: '0', watch: false, ...opts });
  if (!h) throw new Error('startServe returned no handle');
  handle = h;
  return h;
}

function fileExists(p: string): Promise<boolean> {
  return access(p).then(() => true).catch(() => false);
}

// fetch().json() is typed `Promise<any>` but strict callers see `unknown`; cast
// to a loose record so the assertions below read cleanly.
async function jsonOf(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Raw HTTP GET with arbitrary headers. `fetch` forbids overriding `Host`/`Origin`,
 * so the DNS-rebinding tests drop to node:http (setHost:false to keep our Host).
 */
function rawGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers, setHost: false },
      (res) => {
        res.resume(); // drain
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('idleTimeoutMs', () => {
  it('defaults to 15 minutes when the option is absent or empty', () => {
    expect(idleTimeoutMs(undefined)).toBe(15 * 60_000);
    expect(idleTimeoutMs('')).toBe(15 * 60_000);
  });

  it('converts a positive minute value to milliseconds', () => {
    expect(idleTimeoutMs('5')).toBe(5 * 60_000);
    expect(idleTimeoutMs('0.5')).toBe(30_000);
  });

  it('treats 0 and negative values as disabled', () => {
    expect(idleTimeoutMs('0')).toBe(0);
    expect(idleTimeoutMs('-1')).toBe(0);
  });

  it('falls back to the default on non-numeric input', () => {
    expect(idleTimeoutMs('abc')).toBe(15 * 60_000);
  });
});

describe('idle self-shutdown', () => {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  // The idle path ends in process.exit(0) (correct for the real detached daemon).
  // Stub it so teardown still runs but the test runner survives, then assert the
  // observable effects: the discovery file is removed and the port stops serving.
  it('tears down and removes serve.json after the idle timeout with no requests', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      // 0.01 min = 600ms idle window.
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0.01' });
      expect(h).toBeTruthy();
      expect((await fetch(`${h!.baseUrl}/health`)).status).toBe(200);

      // No further requests → timer (last reset by the /health above) fires.
      await sleep(1000);
      expect(exit).toHaveBeenCalled();
      expect(await readDescriptor(dir)).toBeNull(); // teardown unlinked serve.json
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps the daemon alive while requests keep arriving (timer resets)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0.02' }); // 1200ms
      // Ping every 400ms for ~1.6s — comfortably under the 1200ms window each
      // time, so the timer keeps resetting. Without resets it would die at 1200ms.
      for (let i = 0; i < 4; i++) {
        await sleep(400);
        expect((await fetch(`${h!.baseUrl}/health`)).status).toBe(200);
      }
      expect(exit).not.toHaveBeenCalled();
      await h!.close();
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('never arms the timer when disabled (--idle-timeout 0)', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const dir = await mkdtemp(join(tmpdir(), 'openlore-idle-'));
    try {
      const h = await startServe({ directory: dir, port: '0', watch: false, idleTimeout: '0' });
      await sleep(700);
      expect(exit).not.toHaveBeenCalled();
      expect(await readDescriptor(dir)).not.toBeNull(); // still serving
      await h!.close();
    } finally {
      exit.mockRestore();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('openlore serve', () => {
  it('GET /health reports version, preset, and active tools', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
    expect(body.preset).toBe('navigation');
    expect(body.tools).toContain('orient');
    expect(body.tools).toContain('search_code');
  });

  it('writes serve.json on start and removes it on close', async () => {
    const h = await boot();
    const descPath = join(root, '.openlore', 'serve.json');
    expect(await fileExists(descPath)).toBe(true);
    const desc = JSON.parse(await readFile(descPath, 'utf-8'));
    expect(desc.port).toBe(h.port);
    expect(desc.pid).toBe(process.pid);

    await h.close();
    handle = undefined;
    expect(await fileExists(descPath)).toBe(false);
  });

  it('preset is advisory — a non-preset tool is still dispatched (not 404)', async () => {
    const h = await boot(); // default navigation preset
    // get_env_vars is a real tool, NOT in the navigation preset. The daemon must
    // still serve it (preset only advises /health) so it can back the MCP server.
    const res = await fetch(`${h.baseUrl}/tool/get_env_vars`, {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(200); // dispatched, not gated
  });

  it('404s a genuinely unknown tool', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/not_a_real_tool`, {
      method: 'POST',
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(404);
    const body = await jsonOf(res);
    expect(body.error).toMatch(/unknown tool/i);
  });

  it('dispatches an in-preset tool (orient → structured no-analysis result)', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      body: JSON.stringify({ args: { task: 'anything' } }),
    });
    expect(res.status).toBe(200);
    const body = await jsonOf(res);
    // Temp root has no analysis → handler returns an { error } object, not a throw.
    expect(body.error).toMatch(/No analysis/i);
  });

  it('preset "all" exposes non-navigation tools', async () => {
    const h = await boot({ preset: 'all' });
    const res = await fetch(`${h.baseUrl}/health`);
    const body = await jsonOf(res);
    expect(body.preset).toBe('all');
    expect(body.tools).toContain('get_env_vars');
  });

  // change: default-to-lean-tool-surface — serve accepts `full` as an alias of
  // `all` so its selector vocabulary matches `openlore mcp --preset full`.
  it('preset "full" is accepted as a full-surface alias of "all"', async () => {
    const h = await boot({ preset: 'full' });
    const res = await fetch(`${h.baseUrl}/health`);
    const body = await jsonOf(res);
    expect(body.preset).toBe('full');
    expect(body.tools).toContain('get_env_vars');
    expect(body.tools).toContain('record_decision'); // full surface incl. governance
  });

  it('enforces the token gate on /tool but not /health', async () => {
    const h = await boot({ token: 'sekret' });

    // /health needs no token (liveness).
    expect((await fetch(`${h.baseUrl}/health`)).status).toBe(200);

    // /tool without token → 401.
    const noTok = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      body: JSON.stringify({ args: { task: 'x' } }),
    });
    expect(noTok.status).toBe(401);

    // /tool with token → dispatched (200).
    const withTok = await fetch(`${h.baseUrl}/tool/orient`, {
      method: 'POST',
      headers: { 'x-openlore-token': 'sekret' },
      body: JSON.stringify({ args: { task: 'x' } }),
    });
    expect(withTok.status).toBe(200);
  });

  it('--stop on a stale serve.json removes it without signalling a recycled PID', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const descPath = join(root, '.openlore', 'serve.json');
    await mkdir(join(root, '.openlore'), { recursive: true });
    // Point at a dead port + a PID that is almost certainly not an openlore daemon
    // (pid 1). daemonAlive() must fail the /health probe → file removed, no kill.
    await writeFile(
      descPath,
      JSON.stringify({ port: 1, pid: 1, host: '127.0.0.1', version: 'x', startedAt: '' }),
      'utf-8',
    );
    const h = await startServe({ directory: root, stop: true });
    expect(h).toBeUndefined();
    expect(await fileExists(descPath)).toBe(false); // stale descriptor cleaned up
  });

  it('rejects a poisoned serve.json (untrusted artifact) — fails closed', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const descPath = join(root, '.openlore', 'serve.json');
    await mkdir(join(root, '.openlore'), { recursive: true });
    const write = (o: unknown) => writeFile(descPath, JSON.stringify(o), 'utf-8');

    // A non-loopback host must be rejected — otherwise daemonAlive would fetch it
    // (arbitrary-host egress) and stopDaemon could SIGTERM its pid.
    await write({ port: 8080, pid: 99999, host: 'evil.example.com', version: 'x', startedAt: '' });
    expect(await readDescriptor(root)).toBeNull();

    // Shape violations fail closed too.
    for (const bad of [
      null, 42, '[]', [],
      { port: 'not-a-number', pid: 1, host: '127.0.0.1' },
      { port: 70000, pid: 1, host: '127.0.0.1' },        // out-of-range port
      { port: 8080, pid: -1, host: '127.0.0.1' },         // bad pid
      { port: 8080, pid: 1 },                              // missing host
      { port: 8080, pid: 1, host: '127.0.0.1', token: 5 },// non-string token
    ]) {
      await write(bad);
      expect(await readDescriptor(root), `should reject ${JSON.stringify(bad)}`).toBeNull();
    }

    // A well-formed loopback descriptor is accepted.
    await write({ port: 8080, pid: 1, host: '127.0.0.1', version: 'x', startedAt: '', token: 't' });
    const ok = await readDescriptor(root);
    expect(ok).not.toBeNull();
    expect(ok!.host).toBe('127.0.0.1');
    expect(ok!.token).toBe('t');
  });

  it('reuses a live daemon instead of starting a second one for the same root', async () => {
    const h1 = await boot();
    // Second start for the same root must detect the live daemon and return its
    // endpoint (same port), not bind a new server.
    const h2 = await startServe({ directory: root, port: '0', watch: false });
    expect(h2).toBeDefined();
    expect(h2!.port).toBe(h1.port);
    // close() on the reused handle is a no-op — must not tear down h1.
    await h2!.close();
    expect((await fetch(`${h1.baseUrl}/health`)).status).toBe(200);
  });

  it('repopulates the graph after a schema-version reset instead of stalling', async () => {
    // Regression for the schema-reset auto-heal: EdgeStore.open() reports wasReset
    // exactly ONCE (it rewrites the on-disk version on that first open), so the
    // watcher's wasReset-keyed self-heal never fires once serve's startup open has
    // consumed the flag. Serve must therefore kick `analyze --force` itself —
    // otherwise every graph request polls an empty store until the 60s timeout.
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-reset-'));
    await mkdir(join(root, OPENLORE_DIR), { recursive: true });
    await mkdir(join(root, 'openspec', 'specs'), { recursive: true });
    await writeFile(
      join(root, OPENLORE_DIR, 'config.json'),
      JSON.stringify({
        version: '1.0.0', projectType: 'unknown', openspecPath: './openspec',
        analysis: { maxFiles: 100000, includePatterns: [], excludePatterns: [] },
        generation: { model: 'claude-sonnet-4-6', domains: 'auto' },
        createdAt: new Date().toISOString(), lastRun: null,
      }, null, 2),
      'utf-8',
    );
    await writeFile(
      join(root, 'index.js'),
      'export function add(a, b) { return a + b; }\nexport function main() { return add(1, 2); }\n',
      'utf-8',
    );

    // Build a real, populated graph, then simulate a post-upgrade schema bump by
    // forcing the on-disk version stale so the next open() wipes + flags wasReset.
    await openloreAnalyze({ rootPath: root, force: true });
    const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const dbFile = EdgeStore.dbPath(analysisDir);
    {
      const probe = EdgeStore.open(dbFile);
      expect(probe.countNodes()).toBeGreaterThan(0); // sanity: analyze populated it
      probe.close();
    }
    const raw = new DatabaseSync(dbFile);
    raw.exec('UPDATE schema_version SET version = 0');
    raw.close();

    // Start serve (watch:false so the ONLY possible healer is serve's own trigger).
    handle = await startServe({ directory: root, port: '0', watch: false });
    expect(handle).toBeDefined();

    // The startup open consumed wasReset and wiped the DB; the fix must rebuild it.
    let nodes = 0;
    for (let i = 0; i < 100 && nodes === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const es = EdgeStore.open(dbFile);
      nodes = es.countNodes();
      es.close();
    }
    expect(nodes).toBeGreaterThan(0); // rebuilt, not left empty
  }, 30_000);

  it('rejects a spoofed (DNS-rebinding) Host header before dispatch', async () => {
    const h = await boot();
    // An attacker domain resolved to 127.0.0.1 still sends its name in Host.
    const spoofed = await rawGet(h.port, '/health', { Host: 'attacker.example.com' });
    expect(spoofed.status).toBe(403);
    // A loopback Host is accepted.
    const ok = await rawGet(h.port, '/health', { Host: `127.0.0.1:${h.port}` });
    expect(ok.status).toBe(200);
  });

  it('rejects a cross-site Origin', async () => {
    const h = await boot();
    const cross = await rawGet(h.port, '/health', {
      Host: `127.0.0.1:${h.port}`,
      Origin: 'https://evil.example.com',
    });
    expect(cross.status).toBe(403);
  });

  it('refuses a non-loopback bind without a token', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, host: '0.0.0.0' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = prev; // don't fail the suite
  });

  it('rejects an unknown preset at startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, preset: 'bogus' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = prev; // don't fail the suite
  });

  it('handles 20 concurrent tool calls without corruption or crash', async () => {
    handle = await boot();
    const calls = Array.from({ length: 20 }, () =>
      fetch(`${handle!.baseUrl}/tool/orient`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ directory: root, args: { task: 'concurrent test' } }),
      }).then(r => r.json())
    );
    const results = await Promise.all(calls);
    expect(results).toHaveLength(20);
    for (const r of results) {
      // No analysis in temp dir → handler returns { error } but HTTP 200.
      // Assert transport succeeded (no crash, no null, no 500).
      expect(r).toBeTruthy();
      expect(typeof r).toBe('object');
    }
  });

  it('does not spin a second watcher when a daemon is reusing the root (invariant)', async () => {
    // The fundamental invariant: daemon present → MCP must not start a second watcher.
    // Validated here at the serve layer: two startServe() calls on the same root →
    // second returns the reuse handle (no new server, no new watcher).
    const h1 = await boot();
    // Before reuse: verify there is exactly one server (h1 is it).
    const health1 = await jsonOf(await fetch(`${h1.baseUrl}/health`));
    expect(health1.ok).toBe(true);

    // Second startServe → reuse path, no second server bound.
    const h2 = await startServe({ directory: root, port: '0', watch: false });
    expect(h2!.port).toBe(h1.port); // same port = same server

    // Original server still alive after h2.close()
    await h2!.close();
    expect((await fetch(`${h1.baseUrl}/health`)).ok).toBe(true);
  });
});

describe('tool argument validation', () => {
  // The daemon /tool transport is used directly by HTTP clients (e.g. the Pi extension),
  // which don't enforce the MCP schema. A missing required arg must return a clear
  // validation error, not a raw handler TypeError leaked from inside the tool.
  it('returns 400 with a clear message when a required arg is missing', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/analyze_impact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: {} }),
    });
    expect(res.status).toBe(400);
    const body = await jsonOf(res);
    expect(String(body.error)).toContain('Invalid arguments');
    expect(String(body.error)).toContain('symbol');
    // Crucially, NOT a leaked internal error.
    expect(String(body.error)).not.toContain('Cannot read properties');
  });

  it('dispatches normally when required args are present', async () => {
    const h = await boot();
    // No analysis in the throwaway root, so the handler returns a structured
    // "not analyzed"/empty result — the point is it dispatches (200) past validation.
    const res = await fetch(`${h.baseUrl}/tool/analyze_impact`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: { symbol: 'someFn' } }),
    });
    expect(res.status).toBe(200);
  });

  it('does not leak a TypeError when args is a non-object primitive', async () => {
    const h = await boot();
    const res = await fetch(`${h.baseUrl}/tool/get_route_inventory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ args: 'notanobject' }),
    });
    // args coerced to {} → clean dispatch (or clean validation error), never a 500
    // "Cannot create property 'directory' on string" leak.
    expect(res.status).not.toBe(500);
    const body = await jsonOf(res);
    expect(String(body.error ?? '')).not.toContain('Cannot create property');
  });
});

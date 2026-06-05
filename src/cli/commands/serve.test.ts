/**
 * Tests for the `openlore serve` HTTP daemon: endpoints, advisory preset,
 * token gate, dup-daemon reuse, and serve.json discovery-file lifecycle.
 *
 * Served root is a throwaway temp dir (no analysis), so /tool/orient returns a
 * structured "no analysis" object (HTTP 200) without touching the repo's own
 * .openlore. We assert transport behaviour, not handler output.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServe, type ServeHandle } from './serve.js';

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

  it('rejects an unknown preset at startup', async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-serve-'));
    const prev = process.exitCode;
    const h = await startServe({ directory: root, port: '0', watch: false, preset: 'bogus' });
    expect(h).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = prev; // don't fail the suite
  });
});

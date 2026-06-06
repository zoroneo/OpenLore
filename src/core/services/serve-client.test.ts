/**
 * Tests for serve-client — the helper the MCP server uses to discover and call
 * a shared `openlore serve` daemon. Drives a real daemon (startServe) on a
 * temp root; no analysis there, so tools return structured { error } objects —
 * we assert the transport (discover / call / unknown-tool / no-daemon), not the
 * handler output.
 *
 * spawn is never exercised here (it would launch a detached process); we test
 * discover-only paths against a daemon we start in-process.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveCommand, startServe, type ServeHandle } from '../../cli/commands/serve.js';
import { ensureServeDaemon, callServeTool, serveSpawnArgs } from './serve-client.js';

let handle: ServeHandle | undefined;
let root = '';

afterEach(async () => {
  if (handle) { await handle.close(); handle = undefined; }
  if (root) { await rm(root, { recursive: true, force: true }); root = ''; }
});

async function bootDaemon(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), 'openlore-client-'));
  const h = await startServe({ directory: root, port: '0', watch: false });
  if (!h) throw new Error('daemon did not start');
  handle = h;
}

describe('serve-client', () => {
  it('spawn args are accepted by the serve command (no rejected flags)', () => {
    const args = serveSpawnArgs('/some/dir');
    expect(args).toEqual(['serve', '--directory', '/some/dir']);
    // Regression guard: the daemon must accept exactly these. `serve` exposes
    // `--no-watch`, not `--watch`; commander rejects unknown options, which would
    // silently kill the spawned daemon. Parse the flags (minus the leading
    // 'serve') against the real command and assert none are unknown.
    const known = new Set(serveCommand.options.flatMap((o) => [o.short, o.long].filter(Boolean)));
    for (const a of args.slice(1)) {
      if (a.startsWith('-')) {
        expect(known.has(a), `serve rejects ${a}`).toBe(true);
      }
    }
  });


  it('discovers a running daemon (spawn disabled)', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    expect(ep).not.toBeNull();
    expect(ep!.baseUrl).toBe(handle!.baseUrl);
  });

  it('returns null when no daemon is announced and spawn is disabled', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'openlore-client-'));
    try {
      const ep = await ensureServeDaemon(empty, { spawn: false });
      expect(ep).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });

  it('calls a tool and returns its body (handler error object on a bare root)', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    const result = await callServeTool(ep!, 'orient', { task: 'x' }, root) as { error?: string };
    expect(result.error).toMatch(/No analysis/i);
  });

  it('throws on an unknown tool so the caller can fall back', async () => {
    await bootDaemon();
    const ep = await ensureServeDaemon(root, { spawn: false });
    await expect(callServeTool(ep!, 'not_a_real_tool', {}, root)).rejects.toThrow();
  });

  it('throws when the daemon is unreachable (stale endpoint)', async () => {
    const ep = { baseUrl: 'http://127.0.0.1:1' }; // nothing listening
    await expect(callServeTool(ep, 'orient', { task: 'x' }, '/tmp')).rejects.toThrow();
  });
});

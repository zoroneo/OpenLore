/**
 * Tests for McpWatcher runtime-event resilience (harden-runtime-event-resilience).
 *
 * The MCP watcher runs inside the long-lived serve daemon / stdio MCP server —
 * the warm process every connected agent shares. An asynchronous chokidar
 * 'error' on a watcher with no 'error' listener is emitted on an EventEmitter,
 * which THROWS; with no uncaughtException handler in production `src/`, that
 * throw is fatal. These tests pin that every watcher registers an 'error'
 * listener, that a .git watch error degrades (disclose + release, fall back to
 * the batch-size VCS threshold) instead of crashing, and that a post-ready
 * source-watcher error is disclosed rather than silently swallowed.
 *
 * The chokidar mock returns REAL EventEmitters (not a handler map), so
 * emit('error') reproduces Node's throw-on-no-listener semantics exactly — the
 * failure this change prevents.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMContext } from '../analyzer/artifact-generator.js';

// ── chokidar mock: real EventEmitters so 'error' throws with no listener ──────

type FakeWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };
const createdWatchers: FakeWatcher[] = [];

vi.mock('chokidar', () => ({
  default: {
    watch: vi.fn(() => {
      const em = new EventEmitter() as FakeWatcher;
      em.setMaxListeners(50);
      em.close = vi.fn().mockResolvedValue(undefined);
      createdWatchers.push(em);
      // Real chokidar fires 'ready' asynchronously; emit on the next microtask so
      // start()'s 'ready' listener is attached first and the start promise resolves.
      queueMicrotask(() => em.emit('ready'));
      return em;
    }),
  },
}));

// ── fixtures ─────────────────────────────────────────────────────────────────

function makeContext(): LLMContext {
  return {
    phase1_survey: { purpose: '', files: [], totalTokens: 0 },
    phase2_deep:   { purpose: '', files: [], totalTokens: 0 },
    phase3_validation: { purpose: '', files: [], totalTokens: 0 },
    signatures: [],
  };
}

async function setupProject(): Promise<{ rootPath: string; outputPath: string }> {
  const rootPath = await mkdtemp(join(tmpdir(), 'watcher-resilience-'));
  const outputPath = join(rootPath, '.openlore', 'analysis');
  await mkdir(outputPath, { recursive: true });
  await writeFile(join(outputPath, 'llm-context.json'), JSON.stringify(makeContext(), null, 2), 'utf-8');
  return { rootPath, outputPath };
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('McpWatcher — runtime event resilience', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    createdWatchers.length = 0;
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('registers an error listener on both the source and .git watchers', async () => {
    const { rootPath, outputPath } = await setupProject();
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath, embed: false });
    await watcher.start();

    // start() creates exactly two watchers: [0] the source tree, [1] the .git refs.
    expect(createdWatchers.length).toBe(2);
    const [fsWatcher, gitWatcher] = createdWatchers;
    expect(fsWatcher.listenerCount('error')).toBe(1);
    expect(gitWatcher.listenerCount('error')).toBe(1);

    await watcher.stop();
  });

  it('control: an EventEmitter error with no listener throws (the pre-fix fate)', () => {
    // Documents WHY the listeners above matter — this is what a bare watcher does.
    expect(() => new EventEmitter().emit('error', new Error('boom'))).toThrow('boom');
  });

  it('degrades on a .git watch error — discloses, releases, and does not crash', async () => {
    const { rootPath, outputPath } = await setupProject();
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath, embed: false });
    await watcher.start();
    const gitWatcher = createdWatchers[1];
    stderrSpy.mockClear();

    // An async chokidar error (FD pressure, a locked .git/index, ref churn) must
    // NOT propagate as an unhandled 'error' event and kill the host.
    expect(() => gitWatcher.emit('error', new Error('EMFILE: too many open files'))).not.toThrow();

    const disclosed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(disclosed).toMatch(/\.git ref watcher error/);
    expect(disclosed).toMatch(/batch-size threshold/);
    expect(gitWatcher.close).toHaveBeenCalledTimes(1);

    await watcher.stop();
  });

  it('keeps serving after a .git watch error — file changes still index', async () => {
    const { rootPath, outputPath } = await setupProject();
    await mkdir(join(rootPath, 'src'), { recursive: true });
    const srcFile = join(rootPath, 'src', 'auth.ts');
    await writeFile(srcFile, 'export function login(user: string): boolean { return true; }', 'utf-8');

    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath, embed: false });
    await watcher.start();
    createdWatchers[1].emit('error', new Error('EPERM: locked .git/index'));

    // The watcher is still fully functional: a change flows through to signatures.
    await watcher.handleChange(srcFile);
    const ctx = JSON.parse(await readFile(join(outputPath, 'llm-context.json'), 'utf-8')) as LLMContext;
    expect(ctx.signatures?.some(s => s.path === 'src/auth.ts')).toBe(true);

    await watcher.stop();
  });

  it('discloses a post-ready source-watcher error instead of silently swallowing it', async () => {
    const { rootPath, outputPath } = await setupProject();
    const { McpWatcher } = await import('./mcp-watcher.js');
    const watcher = new McpWatcher({ rootPath, outputPath, embed: false });
    await watcher.start();
    const fsWatcher = createdWatchers[0];
    stderrSpy.mockClear();

    // Before hardening this hit reject() on an already-settled promise — safe but
    // silent. Now it discloses and the process survives.
    expect(() => fsWatcher.emit('error', new Error('ENOSPC'))).not.toThrow();
    const disclosed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(disclosed).toMatch(/source watcher error/);

    await watcher.stop();
  });
});

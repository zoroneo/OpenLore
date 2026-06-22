/**
 * Lifecycle tests for the opt-in panic hooks (install ↔ uninstall symmetry,
 * format-update on re-run, and user-hook preservation).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { installPanicCheckHook, installGryphWatchHook, uninstallPanicHooks } from './setup.js';

interface Settings {
  hooks?: {
    PreToolUse?: Array<{ command?: string }>;
    UserPromptSubmit?: Array<{ command?: string }>;
  };
}

async function readSettings(dir: string): Promise<Settings> {
  return JSON.parse(await readFile(join(dir, '.claude', 'settings.json'), 'utf-8')) as Settings;
}

describe('panic hook lifecycle', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-hooks-test-'));
    // silence logger output
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('installs panic-check (PreToolUse) and gryph-watch (UserPromptSubmit)', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installGryphWatchHook(dir);
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0].command).toContain('--format claude');
    expect(s.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it('is idempotent — re-running the same format does not duplicate', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installPanicCheckHook(dir, 'claude');
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
  });

  it('updates the command in place when the format changes (no stale duplicate)', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installPanicCheckHook(dir, 'codex');
    const s = await readSettings(dir);
    expect(s.hooks?.PreToolUse).toHaveLength(1);
    expect(s.hooks?.PreToolUse?.[0].command).toContain('--format codex');
    expect(s.hooks?.PreToolUse?.[0].command).not.toContain('--format claude');
  });

  it('uninstall removes openlore hooks but preserves user-authored hooks', async () => {
    await installPanicCheckHook(dir, 'claude');
    await installGryphWatchHook(dir);
    // Inject a user hook that must survive.
    const s = await readSettings(dir);
    s.hooks!.PreToolUse!.push({ command: 'my-own-tool --check' });
    await writeFile(join(dir, '.claude', 'settings.json'), JSON.stringify(s, null, 2), 'utf-8');

    await uninstallPanicHooks(dir);
    const after = await readSettings(dir);
    expect(after.hooks?.PreToolUse).toHaveLength(1);
    expect(after.hooks?.PreToolUse?.[0].command).toBe('my-own-tool --check');
    expect(after.hooks?.UserPromptSubmit).toBeUndefined(); // only ours was there → key dropped
  });

  it('uninstall is a no-op (never throws) when no settings file exists', async () => {
    await expect(uninstallPanicHooks(dir)).resolves.toBeUndefined();
  });
});

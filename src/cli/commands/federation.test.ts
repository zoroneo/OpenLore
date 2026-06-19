/**
 * `openlore federation` CLI behavior — corrupt-manifest handling.
 *
 * Regression: `list` and `remove` had no try/catch (unlike `add`), so a corrupt
 * `.openlore/federation.json` made `loadRegistry` throw an UNCAUGHT exception — a raw
 * Node stack trace with no clean exit code. They must instead print a `✗ <message>`
 * and set `process.exitCode = 1`, like `add` does. (change: add-multi-repo-federation)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { federationCommand } from './federation.js';
import { federationManifestPath } from '../../core/federation/registry.js';

let home: string;
let prevCwd: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fedcli-'));
  prevCwd = process.cwd();
  process.chdir(home);
  process.exitCode = undefined;
});
afterEach(() => {
  process.chdir(prevCwd);
  rmSync(home, { recursive: true, force: true });
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function writeCorruptManifest(): void {
  mkdirSync(join(home, '.openlore'), { recursive: true });
  writeFileSync(federationManifestPath(home), '{ not valid json');
}

describe('federation CLI on a corrupt manifest', () => {
  it('`list` reports a clean error and exits 1 (no uncaught throw)', async () => {
    writeCorruptManifest();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(federationCommand.parseAsync(['list'], { from: 'user' })).resolves.toBeDefined();
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/✗.*JSON/i);
  });

  it('`remove` reports a clean error and exits 1 (no uncaught throw)', async () => {
    writeCorruptManifest();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(federationCommand.parseAsync(['remove', 'ghost'], { from: 'user' })).resolves.toBeDefined();
    expect(process.exitCode).toBe(1);
    expect(err.mock.calls.flat().join(' ')).toMatch(/✗.*JSON/i);
  });
});

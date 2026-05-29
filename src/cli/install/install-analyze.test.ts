/**
 * Tests for `openlore install`'s one-command setup: after wiring agent surfaces
 * it should build the index (init + analyze) so orient() works on the first
 * session, unless --no-analyze (analyze: false) is passed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './index.js';

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

describe('openlore install — auto index build', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-install-analyze-'));
    // A minimal but real TS project so analyze has something to index.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'tmp', version: '1.0.0' }));
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(
      join(dir, 'src', 'index.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n'
    );
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('default install builds the index (.openlore + vector-index) so orient works immediately', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(code).toBe(0);
    // Surfaces wired…
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    // …AND the index was built (init created config; analyze wrote the index).
    expect(await exists(join(dir, '.openlore/config.json'))).toBe(true);
    expect(await exists(join(dir, '.openlore/analysis/vector-index'))).toBe(true);
  }, 30_000);

  it('--no-analyze (analyze:false) configures surfaces but does NOT build the index', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code', analyze: false });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    // No analysis artifacts produced.
    expect(await exists(join(dir, '.openlore/analysis/vector-index'))).toBe(false);
  });

  it('dry-run never builds the index', async () => {
    const code = await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.openlore'))).toBe(false);
  });
});

/**
 * `openlore status` CLI behavior (change: add-substrate-status-surface).
 * Guards the two spec scenarios that are CLI-shaped: the bare-repo degradation
 * (one instruction, exit 0) and `--json` machine output. The section data itself
 * is covered by status-report.test.ts. Plain .test.ts so CI runs it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusCommand } from './status.js';
import { OPENLORE_DIR } from '../../constants.js';

let dir: string;
let cwd: string;
let out: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-status-cli-'));
  cwd = process.cwd();
  process.chdir(dir);
  out = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
  });
  process.exitCode = undefined;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
  process.exitCode = undefined;
});

const run = (args: string[] = []): Promise<unknown> => statusCommand.parseAsync(args, { from: 'user' });

describe('openlore status CLI', () => {
  it('a bare repo prints one install instruction and exits 0', async () => {
    await run();
    const text = out.join('\n');
    expect(text).toMatch(/Nothing set up here/);
    expect(text).toMatch(/openlore install/);
    // Not an error: no non-zero exit code was set.
    expect(process.exitCode).toBeFalsy();
  });

  it('a configured repo renders the section pane', async () => {
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    await writeFile(join(dir, OPENLORE_DIR, 'config.json'), JSON.stringify({ version: '1.0.0', projectType: 'nodejs' }));
    await run();
    const text = out.join('\n');
    expect(text).toMatch(/Index/);
    expect(text).toMatch(/Search/);
    expect(text).toMatch(/Governance/);
  });

  it('--json emits a parseable report with every section', async () => {
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    await writeFile(join(dir, OPENLORE_DIR, 'config.json'), JSON.stringify({ version: '1.0.0', projectType: 'nodejs' }));
    await run(['--json']);
    const parsed = JSON.parse(out.join('\n'));
    expect(parsed.configured).toBe(true);
    for (const key of ['index', 'search', 'live', 'wiring', 'governance', 'version']) {
      expect(parsed[key], `missing section ${key}`).toBeDefined();
    }
  });
});

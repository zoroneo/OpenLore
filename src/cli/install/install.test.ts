import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstall } from './index.js';

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

describe('openlore install (end-to-end)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-install-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('--dry-run writes nothing', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const code = await runInstall({ cwd: dir, agent: 'claude-code', dryRun: true });
    expect(code).toBe(0);
    const md = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(md).toBe('# project\n');
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(false);
  });

  it('agent-md install creates AGENTS.md with managed block', async () => {
    const code = await runInstall({ cwd: dir, agent: 'agents-md' });
    expect(code).toBe(0);
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(md).toContain('BEGIN OPENLORE');
    expect(md).toContain('orient()');
  });

  it('claude-code install creates settings.json with SessionStart + mcpServers', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    const code = await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.mcpServers.openlore).toEqual({
      command: 'npx',
      args: ['--yes', 'openlore', 'mcp'],
    });
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(
      'npx --yes openlore orient --json'
    );
    expect(settings._openlore.managed).toBe(true);
  });

  it('re-running install is a no-op (no writes, exit 0)', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await runInstall({ cwd: dir, agent: 'claude-code' });
    const mdBefore = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    const settingsBefore = await readFile(join(dir, '.claude/settings.json'), 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(mdBefore);
    expect(await readFile(join(dir, '.claude/settings.json'), 'utf8')).toBe(settingsBefore);
  });

  it('refuses to overwrite hand-edited block without --force', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md' });
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    const tampered = md.replace('orient()', 'OOPS-EDITED');
    await writeFile(join(dir, 'AGENTS.md'), tampered, 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'agents-md' });
    expect(code).toBe(1);
    expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe(tampered);
  });

  it('--force overwrites hand-edited block', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md' });
    const md = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    const tampered = md.replace('orient()', 'OOPS-EDITED');
    await writeFile(join(dir, 'AGENTS.md'), tampered, 'utf8');

    const code = await runInstall({ cwd: dir, agent: 'agents-md', force: true });
    expect(code).toBe(0);
    const after = await readFile(join(dir, 'AGENTS.md'), 'utf8');
    expect(after).not.toContain('OOPS-EDITED');
    expect(after).toContain('orient()');
  });

  it('--uninstall restores a pre-existing CLAUDE.md byte-for-byte', async () => {
    const original = '# my project\n\nsome notes\n';
    await writeFile(join(dir, 'CLAUDE.md'), original);
    await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).not.toBe(original);

    const code = await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    expect(code).toBe(0);
    expect(await readFile(join(dir, 'CLAUDE.md'), 'utf8')).toBe(original);
    // settings.json was created by us, so it should be removed
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(false);
  });

  it('--uninstall removes AGENTS.md when it was OpenLore-only', async () => {
    await runInstall({ cwd: dir, agent: 'agents-md' });
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(true);
    await runInstall({ cwd: dir, agent: 'agents-md', uninstall: true });
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(false);
  });

  it('preserves user-defined SessionStart hooks alongside ours', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.claude'), { recursive: true });
    const userHook = {
      matcher: 'shell',
      hooks: [{ type: 'command', command: 'echo hello' }],
    };
    await writeFile(
      join(dir, '.claude/settings.json'),
      JSON.stringify({ hooks: { SessionStart: [userHook] } }, null, 2),
      'utf8'
    );

    const code = await runInstall({ cwd: dir, agent: 'claude-code' });
    expect(code).toBe(0);
    const settings = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(settings.hooks.SessionStart).toHaveLength(2);
    expect(settings.hooks.SessionStart[0]).toEqual(userHook);
    expect(settings.hooks.SessionStart[1]._openlore).toBe(true);
    expect(settings.hooks.SessionStart[1].hooks[0].command).toBe(
      'npx --yes openlore orient --json'
    );

    await runInstall({ cwd: dir, agent: 'claude-code', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.claude/settings.json'), 'utf8'));
    expect(after.hooks.SessionStart).toEqual([userHook]);
    expect(after.mcpServers).toBeUndefined();
    expect(after._openlore).toBeUndefined();
  });

  it('cursor install writes .cursor/mcp.json with mcpServers.openlore', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const code = await runInstall({ cwd: dir, agent: 'cursor' });
    expect(code).toBe(0);
    const mcp = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    expect(mcp.mcpServers.openlore).toEqual({
      command: 'npx',
      args: ['--yes', 'openlore', 'mcp'],
    });
    expect(mcp._openlore.managed).toBe(true);

    // Uninstall removes the file when it only had our entries.
    await runInstall({ cwd: dir, agent: 'cursor', uninstall: true });
    expect(await exists(join(dir, '.cursor/mcp.json'))).toBe(false);
  });

  it('cursor install preserves pre-existing non-OpenLore mcpServers', async () => {
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const existing = { mcpServers: { other: { command: 'foo' } } };
    await writeFile(join(dir, '.cursor/mcp.json'), JSON.stringify(existing, null, 2));

    await runInstall({ cwd: dir, agent: 'cursor' });
    const merged = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    expect(merged.mcpServers.other).toEqual({ command: 'foo' });
    expect(merged.mcpServers.openlore.command).toBe('npx');

    await runInstall({ cwd: dir, agent: 'cursor', uninstall: true });
    const after = JSON.parse(await readFile(join(dir, '.cursor/mcp.json'), 'utf8'));
    expect(after.mcpServers.other).toEqual({ command: 'foo' });
    expect(after.mcpServers.openlore).toBeUndefined();
  });

  it('auto-detects multiple surfaces when no --agent passed', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# project\n');
    await mkdir(join(dir, '.cursor'), { recursive: true });
    const code = await runInstall({ cwd: dir });
    expect(code).toBe(0);
    expect(await exists(join(dir, '.claude/settings.json'))).toBe(true);
    expect(await exists(join(dir, '.cursor/rules/openlore.mdc'))).toBe(true);
    expect(await exists(join(dir, 'AGENTS.md'))).toBe(true); // universal fallback
  });
});

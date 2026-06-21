/**
 * Panic subsystem — end-to-end against the real built CLI binary.
 *
 * Codifies the dogfooding that found two real bugs (the mode:'off' panic.jsonl
 * leak and the cross-writer revision regression). Spawns `node dist/cli/index.js`
 * so it exercises the exact code path an agent's hook runtime would.
 *
 * Skipped automatically when dist/ is not built (so it never breaks cold CI;
 * this is an *.integration.test.ts, excluded from `npm run test:run`). Run with:
 *   npm run build && npx vitest run src/cli/commands/panic.e2e.integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(import.meta.dirname, '../../../');
const CLI = join(REPO_ROOT, 'dist/cli/index.js');
const haveCli = existsSync(CLI);

/** Run the CLI; return { stdout, code }. Never throws on non-zero (panic CLI always exits 0). */
function run(args: string[]): { stdout: string; code: number } {
  try {
    const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf-8' });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', code: err.status ?? 1 };
  }
}

function setMode(dir: string, mode: string): void {
  writeFileSync(join(dir, '.openlore', 'config.json'), JSON.stringify({ panicResponse: { mode } }));
}
function writeState(dir: string, state: Record<string, unknown>): void {
  writeFileSync(join(dir, '.openlore', 'panic-state.json'), JSON.stringify(state));
}
function freshState(over: Record<string, unknown>): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1, panicScore: 0, panicLevel: 0, updatedAt: now, lastOrientAt: now,
    recentOrientCount: 0, localityConfidence: 0, interventionCountSinceStable: 0,
    triggers: [], revision: 1, ...over,
  };
}

describe.skipIf(!haveCli)('panic CLI — e2e against the built binary', () => {
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'panic-e2e-'));
    mkdirSync(join(dir, '.openlore'), { recursive: true });
  });

  it('fails open with no config: panic-check exits 0 and is silent', () => {
    rmSync(join(dir, '.openlore', 'config.json'), { force: true });
    rmSync(join(dir, '.openlore', 'panic-state.json'), { force: true });
    const r = run(['panic-check', '--directory', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('panic-level is empty (L0) when there is no state', () => {
    const r = run(['panic-level', '--directory', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('observe mode passes through silently (no intervention)', () => {
    setMode(dir, 'observe');
    writeState(dir, freshState({ panicScore: 70, panicLevel: 3 }));
    const r = run(['panic-check', '--directory', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  it('advisory mode warns at a high level and panic-level reports it', () => {
    setMode(dir, 'advisory');
    writeState(dir, freshState({ panicScore: 70, panicLevel: 3 }));
    const check = run(['panic-check', '--directory', dir, '--format', 'claude']);
    expect(check.code).toBe(0);
    expect(JSON.parse(check.stdout.trim()).decision).toBe('warn');
    const level = run(['panic-level', '--directory', dir]);
    expect(level.stdout.trim()).toBe('P:L3');
  });

  it('fails open on a corrupt state file (decision allow, exit 0)', () => {
    setMode(dir, 'advisory');
    writeFileSync(join(dir, '.openlore', 'panic-state.json'), 'not json {{{');
    const r = run(['panic-check', '--directory', dir]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim()).decision).toBe('allow');
  });

  it('fails open on an expired session (>30min old → treated as stable)', () => {
    setMode(dir, 'advisory');
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeState(dir, freshState({ panicScore: 80, panicLevel: 4, updatedAt: old, lastOrientAt: old }));
    expect(JSON.parse(run(['panic-check', '--directory', dir]).stdout.trim()).decision).toBe('allow');
    expect(run(['panic-level', '--directory', dir]).stdout.trim()).toBe('');
  });

  it('telemetry renders the observe-mode validation gate from real panic.jsonl', () => {
    const tel = join(dir, '.openlore', 'telemetry');
    mkdirSync(tel, { recursive: true });
    const base = Date.parse('2026-06-21T10:00:00Z');
    const ts = (s: number) => new Date(base + s * 1000).toISOString();
    const events = [
      { ts: ts(0), event: 'panic_level_change', from_level: 0, to_level: 2 },
      { ts: ts(5), event: 'hook_intervention', intervention_count: 1 },
      { ts: ts(8), event: 'panic_intervention_outcome', outcome: 'responded' },
      { ts: ts(9), event: 'panic_orient_reset', orient_kind: 'normal', delta: -40 },
      { ts: ts(10), event: 'panic_level_change', from_level: 2, to_level: 0 },
    ];
    writeFileSync(join(tel, 'panic.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    const r = run(['telemetry', dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('OBSERVE-MODE VALIDATION');
    expect(r.stdout).toMatch(/gate verdict\s+:\s+INSUFFICIENT_DATA/);
    // never auto-cleared
    expect(r.stdout).not.toContain('CLEARED  (');
  });
});

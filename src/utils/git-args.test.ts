/**
 * fix-git-path-quoting — the shared quoting discipline and its structural guard.
 *
 * `gitPathArgs` is the one home for `-c core.quotepath=false`. The guard test
 * converts a per-site discipline into a CI-enforced invariant: any `git` spawn
 * that parses a path list from stdout (`--name-only` / `--name-status` /
 * `--numstat`, or `ls-files`) MUST route its argv through `gitPathArgs`, so a
 * new unguarded site can't silently reintroduce the non-ASCII-path drop.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitPathArgs, GIT_QUOTEPATH_OFF } from './git-args.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(HERE, '..'); // src/

describe('gitPathArgs', () => {
  it('prepends the quotepath-off discipline to the git subcommand argv', () => {
    expect(gitPathArgs('log', '--name-only')).toEqual([
      '-c', 'core.quotepath=false', 'log', '--name-only',
    ]);
  });

  it('is a no-op prefix for an empty subcommand (still valid argv shape)', () => {
    expect(gitPathArgs()).toEqual(['-c', 'core.quotepath=false']);
  });

  it('exposes the exact flag pair as a reusable constant', () => {
    expect([...GIT_QUOTEPATH_OFF]).toEqual(['-c', 'core.quotepath=false']);
  });
});

// ── Structural guard: no unguarded path-list git spawn in src ─────────────────

/** Every `.ts` under src/, excluding tests and the discipline's own home. */
function tsSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === 'fixtures') continue;
      out.push(...tsSourceFiles(full));
      continue;
    }
    if (!entry.endsWith('.ts')) continue;
    if (entry.endsWith('.test.ts') || entry === 'git-args.ts') continue;
    out.push(full);
  }
  return out;
}

// A quoted argv element that makes git emit a path list from stdout.
const PATH_LIST_TOKEN = /(['"])(--name-only|--name-status|--numstat|ls-files)\1/;

describe('git path-quoting guard (structural invariant)', () => {
  it('every git path-list spawn in src routes through gitPathArgs', () => {
    const violations: string[] = [];

    for (const file of tsSourceFiles(SRC_ROOT)) {
      const lines = readFileSync(file, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!PATH_LIST_TOKEN.test(lines[i])) continue;
        // Look at the enclosing argv statement (a small backward window covers
        // multi-line argv arrays; in practice the token and helper share a line).
        const windowText = lines.slice(Math.max(0, i - 4), i + 2).join('\n');
        if (windowText.includes('gitPathArgs(') || windowText.includes('core.quotepath=false')) {
          continue;
        }
        const rel = file.slice(SRC_ROOT.length + 1);
        violations.push(`${rel}:${i + 1}  ${lines[i].trim()}`);
      }
    }

    expect(
      violations,
      `Unguarded git path-list spawn(s) found — wrap the argv in gitPathArgs() ` +
        `so non-ASCII paths aren't octal-escaped and silently dropped:\n${violations.join('\n')}`,
    ).toEqual([]);
  });

  it('the guard actually detects an unguarded spawn (negative control)', () => {
    const bad = `execFileAsync('git', ['diff', '--name-status', ref], opts);`;
    const good = `execFileAsync('git', gitPathArgs('diff', '--name-status', ref), opts);`;
    expect(PATH_LIST_TOKEN.test(bad)).toBe(true);
    expect(bad.includes('gitPathArgs(') || bad.includes('core.quotepath=false')).toBe(false);
    expect(good.includes('gitPathArgs(')).toBe(true);
  });
});

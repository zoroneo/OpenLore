/**
 * CI guard for the vi.mock hoisting deprecation (TestSuiteHasNoKnownTimeBombs,
 * change: fix-test-suite-hygiene).
 *
 * vitest hoists every `vi.mock(...)` to the top of its module, so a call written
 * inside `describe`/`it`/`beforeAll` runs earlier than it reads — vitest warns on
 * every such call and has announced it "will become an error in a future version".
 * A green suite would then flip red on a routine vitest upgrade.
 *
 * This test fails the moment such a call is introduced (the warning becomes a hard
 * failure now, in plain unit-test CI, instead of at upgrade time). A top-level
 * `vi.mock` starts at column 0; an indented one is inside a block — exactly the
 * shape vitest warns about.
 */

import { describe, it, expect } from 'vitest';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'test', 'examples'];
/** vi.mock preceded by whitespace on its line = not at module top level. */
const INDENTED_VI_MOCK = /^[ \t]+vi\.mock\s*\(/m;

function testFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // an absent root (e.g. gitignored test/) is fine
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...testFiles(full));
    } else if (entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('vitest hygiene', () => {
  it('every vi.mock call is at module top level (no hoisting deprecation)', () => {
    const offenders = testFiles('src')
      .concat(ROOTS.slice(1).flatMap(testFiles))
      // Exclude this guard's own explanatory regex literal.
      .filter((f) => !f.endsWith('vitest-hygiene.test.ts'))
      .filter((f) => INDENTED_VI_MOCK.test(readFileSync(f, 'utf-8')));

    expect(
      offenders,
      `vi.mock must be at module top level (vitest hoists it and warns → future error). ` +
        `Move it out of describe/it/beforeAll:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

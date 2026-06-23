import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { testCommand } from './test.js';

// Regression guard for a doc-drift bug found by dogfooding: docs/cli-reference.md and
// docs/spec-tests.md referenced `openlore test --coverage`, but the `test` command stopped
// generating stubs (commit 7f2dd4b) and `--coverage` never existed on the coverage-report
// command — its flags are --min-coverage / --discover / --use-llm / --domains / --test-dirs / --json.
// This asserts every `openlore test --<flag>` the docs show is a real option, so the docs
// can't drift back to a non-existent flag.
const repoRoot = join(import.meta.dirname, '..', '..', '..');
const DOCS = ['docs/cli-reference.md', 'docs/spec-tests.md'];

describe('documented `openlore test` flags', () => {
  const realLongFlags = new Set(testCommand.options.map(o => o.long).filter(Boolean) as string[]);

  it('the test command reports coverage (it no longer generates stub tests)', () => {
    expect(testCommand.description().toLowerCase()).toContain('coverage');
    expect(realLongFlags.has('--coverage')).toBe(false);
    expect(realLongFlags.has('--min-coverage')).toBe(true);
  });

  it.each(DOCS)('every `openlore test --flag` in %s is a real option', rel => {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    const flags = [...text.matchAll(/openlore test\s+(--[a-z][\w-]*)/g)].map(m => m[1]);
    for (const flag of flags) {
      expect(realLongFlags.has(flag), `${rel} documents \`openlore test ${flag}\` but that flag does not exist`).toBe(true);
    }
  });
});

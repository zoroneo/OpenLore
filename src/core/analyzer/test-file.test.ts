/**
 * Tests for the canonical cross-language test-file predicate. These lock in the
 * coverage that the call-graph builder previously LACKED (its narrower local copy
 * let directory-convention tests leak into the production graph and dropped
 * `tested_by` edges) — call-graph and artifact-generator now share this predicate.
 */

import { describe, it, expect } from 'vitest';
import { isTestFile } from './test-file.js';

describe('isTestFile', () => {
  it('detects directory-convention and framework test layouts', () => {
    const tests = [
      'src/foo.test.ts',
      'src/foo.spec.tsx',
      'src/__tests__/foo.ts',          // ← missed by the old call-graph copy
      'tests/foo.ts',                  // ← missed
      'tests/foo.rb',                  // ← missed
      'tests/foo.php',                 // ← missed
      'test/foo.py',                   // ← missed
      'pkg/foo_test.go',
      'app/test_foo.py',
      'src/FooTest.java',
      'src/FooSpec.kt',                // ← missed
      'src/FooTest.scala',             // ← missed
    ];
    for (const f of tests) expect(isTestFile(f), f).toBe(true);
  });

  it('does not flag ordinary source files', () => {
    const nonTests = [
      'src/foo.ts',
      'src/app-config.ts',
      'src/contest.ts',                // contains "test" but not a test file
      'src/latest.ts',
      'lib/protest.py',
      'src/Foo.java',
    ];
    for (const f of nonTests) expect(isTestFile(f), f).toBe(false);
  });

  it('normalizes Windows path separators', () => {
    expect(isTestFile('src\\__tests__\\foo.ts')).toBe(true);
    expect(isTestFile('src\\foo.test.ts')).toBe(true);
  });
});

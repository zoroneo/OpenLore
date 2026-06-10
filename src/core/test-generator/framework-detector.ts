/**
 * Framework Detector
 *
 * Auto-detects the test framework used in a project by inspecting
 * well-known configuration files, without any LLM call.
 *
 * Detection order (first match wins):
 *   1. vitest     — package.json has vitest dependency
 *   2. playwright — package.json has @playwright/test dependency
 *   3. junit      — pom.xml (Maven) or build.gradle[.kts] (Gradle) exists
 *   4. gotest     — go.mod exists
 *   5. pytest     — pyproject.toml, setup.cfg, or pytest.ini exists
 *   6. gtest      — CMakeLists.txt contains GTest or googletest
 *   7. catch2     — CMakeLists.txt contains Catch2, or catch2 header exists
 *   → falls back to 'vitest' when nothing is detected
 *
 * Order rationale: JS/TS markers are checked first because a polyglot repo's
 * package.json names a specific runner; Java/Go build manifests are
 * language-unambiguous, so they precede the file-existence-only Python and
 * CMake checks.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileExists } from '../../utils/command-helpers.js';
import type { TestFramework } from '../../types/test-generator.js';

export async function detectFramework(rootPath: string): Promise<TestFramework> {
  // ── 1. Check package.json for JS/TS frameworks ──────────────────────────
  const pkgPath = join(rootPath, 'package.json');
  if (await fileExists(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
      const allDeps: Record<string, string> = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };
      if ('vitest' in allDeps) return 'vitest';
      if ('@playwright/test' in allDeps) return 'playwright';
    } catch {
      // Malformed package.json — continue to next check
    }
  }

  // ── 2. Check for Java/Kotlin (Maven or Gradle → JUnit) ───────────────────
  const javaMarkers = [
    join(rootPath, 'pom.xml'),
    join(rootPath, 'build.gradle'),
    join(rootPath, 'build.gradle.kts'),
    join(rootPath, 'settings.gradle'),
    join(rootPath, 'settings.gradle.kts'),
  ];
  for (const marker of javaMarkers) {
    if (await fileExists(marker)) return 'junit';
  }

  // ── 3. Check for Go (go.mod → go test) ───────────────────────────────────
  if (await fileExists(join(rootPath, 'go.mod'))) return 'gotest';

  // ── 4. Check for Python pytest ───────────────────────────────────────────
  const pythonMarkers = [
    join(rootPath, 'pyproject.toml'),
    join(rootPath, 'setup.cfg'),
    join(rootPath, 'pytest.ini'),
    join(rootPath, 'setup.py'),
  ];
  for (const marker of pythonMarkers) {
    if (await fileExists(marker)) return 'pytest';
  }

  // ── 5. Check CMakeLists.txt for C++ frameworks ───────────────────────────
  const cmakePath = join(rootPath, 'CMakeLists.txt');
  if (await fileExists(cmakePath)) {
    try {
      const cmake = await readFile(cmakePath, 'utf-8');
      if (/\bCatch2\b/i.test(cmake)) return 'catch2';
      if (/\bgoogletest\b|\bGTest\b/i.test(cmake)) return 'gtest';
    } catch {
      // ignore
    }
  }

  // ── 6. Default ───────────────────────────────────────────────────────────
  return 'vitest';
}

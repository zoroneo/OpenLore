/**
 * Tests for cross-language test-framework auto-detection.
 *
 * Locks in that Java (Maven/Gradle) and Go projects resolve to junit/gotest
 * rather than silently falling back to the vitest default — the regression
 * reported in issue #138 ("link/create tests only works with vitest").
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { detectFramework } from './framework-detector.js';

let dir: string;

beforeEach(async () => {
  dir = join(tmpdir(), `fw-detect-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('detectFramework', () => {
  it('detects vitest from package.json devDependencies', async () => {
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    expect(await detectFramework(dir)).toBe('vitest');
  });

  it('detects junit from a Maven pom.xml', async () => {
    await writeFile(join(dir, 'pom.xml'), '<project></project>');
    expect(await detectFramework(dir)).toBe('junit');
  });

  it('detects junit from a Gradle build file', async () => {
    await writeFile(join(dir, 'build.gradle'), 'plugins { id "java" }');
    expect(await detectFramework(dir)).toBe('junit');
  });

  it('detects junit from a Kotlin Gradle build file', async () => {
    await writeFile(join(dir, 'build.gradle.kts'), 'plugins { kotlin("jvm") }');
    expect(await detectFramework(dir)).toBe('junit');
  });

  it('detects gotest from go.mod', async () => {
    await writeFile(join(dir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
    expect(await detectFramework(dir)).toBe('gotest');
  });

  it('detects pytest from pyproject.toml', async () => {
    await writeFile(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
    expect(await detectFramework(dir)).toBe('pytest');
  });

  it('prefers a JS/TS runner over a co-located Java build file', async () => {
    // Polyglot repo: package.json names the runner explicitly, so it wins.
    await writeFile(join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    await writeFile(join(dir, 'pom.xml'), '<project></project>');
    expect(await detectFramework(dir)).toBe('vitest');
  });

  it('falls back to vitest when nothing is detected', async () => {
    expect(await detectFramework(dir)).toBe('vitest');
  });
});

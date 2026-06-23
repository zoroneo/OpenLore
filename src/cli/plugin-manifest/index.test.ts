/**
 * Exercises the plugin-manifest command's exit-code contract and `emit --json`
 * stdout purity — the delegated surface OpenSpec depends on. The command actions
 * delegate to `runPluginManifestEmit` / `runPluginManifestValidate`, which return
 * the exit code (mirroring the federation `runManifestValidate` pattern) so the
 * contract is testable without spawning a process.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureLogger } from '../../utils/logger.js';
import {
  ownPackageRoot,
  runPluginManifestEmit,
  runPluginManifestValidate,
} from './index.js';

// Keep test output clean; logger.error/success/info would otherwise print.
beforeAll(() => configureLogger({ quiet: true }));

const VALID = {
  manifestVersion: 1,
  id: 'demo',
  namespace: 'demo',
  bin: 'demo',
  openspecCompat: '>=0.1.0',
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugin-manifest-e2e-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runPluginManifestValidate exit codes', () => {
  it('returns 0 for OpenLore\'s own (valid) manifest', () => {
    expect(runPluginManifestValidate(ownPackageRoot())).toBe(0);
  });

  it('returns 1 for a present-but-invalid manifest', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', openspec: { ...VALID, namespace: 'BadNS' } }));
    expect(runPluginManifestValidate(dir)).toBe(1);
  });

  it('returns 2 when no manifest is present', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(runPluginManifestValidate(dir)).toBe(2);
  });

  it('discovers a standalone openspec.plugin.json when the package.json key is absent', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    writeFileSync(join(dir, 'openspec.plugin.json'), JSON.stringify(VALID));
    expect(runPluginManifestValidate(dir)).toBe(0);
  });

  it('prefers the package.json key over a standalone file (key wins)', () => {
    // package.json key is VALID; the standalone file is broken — key must win → 0.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', openspec: VALID }));
    writeFileSync(join(dir, 'openspec.plugin.json'), JSON.stringify({ manifestVersion: 1 }));
    expect(runPluginManifestValidate(dir)).toBe(0);
  });
});

describe('runPluginManifestEmit', () => {
  it('returns 2 when no manifest is present', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    expect(runPluginManifestEmit(dir, true)).toBe(2);
  });

  it('--json writes ONLY the manifest JSON to stdout (no log noise)', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    const code = runPluginManifestEmit(ownPackageRoot(), true);
    spy.mockRestore();

    expect(code).toBe(0);
    const out = writes.join('');
    const parsed = JSON.parse(out); // throws if contaminated → fails the test
    expect(parsed.namespace).toBe('lore');
    expect(parsed.bin).toBe('openlore');
  });
});

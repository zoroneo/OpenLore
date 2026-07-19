/**
 * Guard for the Node-version floor. Two things must hold:
 *   1. checkNodeVersion() classifies versions correctly around the floor, and
 *   2. the floor stays coherent with package.json `engines.node` — so the guard's
 *      message can never promise a different minimum than the package declares.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  checkNodeVersion,
  assertSupportedNode,
  isSqliteAvailable,
  MIN_NODE,
  EXIT_UNSUPPORTED_NODE,
} from './node-version-guard.js';
import { MIN_NODE_MAJOR_VERSION, MIN_NODE_MINOR_VERSION } from '../constants.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('checkNodeVersion', () => {
  it('accepts the exact floor', () => {
    expect(checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor}.0`).ok).toBe(true);
  });

  it('accepts a higher minor and higher major', () => {
    expect(checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor + 3}.1`).ok).toBe(true);
    expect(checkNodeVersion(`${MIN_NODE.major + 1}.0.0`).ok).toBe(true);
  });

  it('rejects a lower minor on the floor major, with a legible message naming both versions', () => {
    const result = checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor - 1}.9`);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`>=${MIN_NODE.major}.${MIN_NODE.minor}`);
    expect(result.message).toContain(`${MIN_NODE.major}.${MIN_NODE.minor - 1}.9`);
  });

  it('rejects a lower major (e.g. the OpenSpec Node-20 floor)', () => {
    expect(checkNodeVersion('20.19.0').ok).toBe(false);
    expect(checkNodeVersion('21.7.3').ok).toBe(false);
  });

  it('exposes a stable, dedicated exit code', () => {
    expect(EXIT_UNSUPPORTED_NODE).toBe(78);
  });
});

describe('Node floor coherence', () => {
  it('MIN_NODE matches package.json engines.node', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')) as {
      engines?: { node?: string };
    };
    const engines = pkg.engines?.node ?? '';
    const match = engines.match(/(\d+)\.(\d+)/);
    expect(match, `engines.node "${engines}" must declare a major.minor floor`).toBeTruthy();
    expect(Number(match![1])).toBe(MIN_NODE.major);
    expect(Number(match![2])).toBe(MIN_NODE.minor);
  });

  it('MIN_NODE matches constants.ts MIN_NODE_MAJOR/MINOR_VERSION', () => {
    // One floor, three declarations (guard, constants, package.json). If any drifts,
    // the guard's message or doctor's copy would promise a different minimum than the
    // package declares.
    expect(MIN_NODE_MAJOR_VERSION).toBe(MIN_NODE.major);
    expect(MIN_NODE_MINOR_VERSION).toBe(MIN_NODE.minor);
  });
});

describe('node:sqlite capability probe', () => {
  it('reports available when getBuiltinModule returns the module', () => {
    expect(isSqliteAvailable(() => ({ DatabaseSync: class {} }))).toBe(true);
  });

  it('reports unavailable when getBuiltinModule returns undefined (flagged/stripped build)', () => {
    expect(isSqliteAvailable(() => undefined)).toBe(false);
  });

  it('reports unavailable (never throws) when getBuiltinModule throws', () => {
    expect(
      isSqliteAvailable(() => {
        throw new Error('ERR_UNKNOWN_BUILTIN_MODULE');
      }),
    ).toBe(false);
  });

  it('is loadable in this test runtime (the CI floor has unflagged node:sqlite)', () => {
    expect(isSqliteAvailable()).toBe(true);
  });
});

describe('checkNodeVersion — capability beats arithmetic', () => {
  it('a version at/above the floor but with node:sqlite unavailable still fails, naming the builtin', () => {
    const result = checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor}.0`, () => false);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('node:sqlite');
  });

  it('a version below the floor fails with the version message even if the probe would pass', () => {
    const result = checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor - 1}.0`, () => true);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(`>=${MIN_NODE.major}.${MIN_NODE.minor}`);
    expect(result.message).not.toContain('node:sqlite');
  });

  it('a version at/above the floor with node:sqlite available passes', () => {
    expect(checkNodeVersion(`${MIN_NODE.major}.${MIN_NODE.minor}.0`, () => true).ok).toBe(true);
  });
});

describe('assertSupportedNode side effect', () => {
  it('on an unsupported Node, writes a legible stderr line and exits 78', () => {
    const orig = process.versions.node;
    Object.defineProperty(process.versions, 'node', { value: '20.0.0', configurable: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      assertSupportedNode();
      expect(exitSpy).toHaveBeenCalledWith(EXIT_UNSUPPORTED_NODE);
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(msg).toContain(`>=${MIN_NODE.major}.${MIN_NODE.minor}`);
      expect(msg).toContain('20.0.0');
    } finally {
      Object.defineProperty(process.versions, 'node', { value: orig, configurable: true });
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });

  it('on a supported Node, does not exit', () => {
    // The test runner itself is on a supported Node (CI floor), so this is a no-op.
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    assertSupportedNode();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('on a version-OK Node where node:sqlite is unavailable, still writes the capability line and exits 78', () => {
    // Version arithmetic passes (the runner is at/above the floor), but the builtin
    // probe fails — the guard must fail honestly, not crash at first EdgeStore.open().
    const proc = process as unknown as { getBuiltinModule?: (id: string) => unknown };
    const origGetBuiltin = proc.getBuiltinModule;
    proc.getBuiltinModule = () => undefined;
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      assertSupportedNode();
      expect(exitSpy).toHaveBeenCalledWith(EXIT_UNSUPPORTED_NODE);
      const msg = errSpy.mock.calls.map((c) => String(c[0])).join('');
      expect(msg).toContain('node:sqlite');
    } finally {
      proc.getBuiltinModule = origGetBuiltin;
      exitSpy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('guard load ordering', () => {
  // ESM hoists static imports, so the guard only runs ahead of commander if the
  // FIRST import is the side-effecting bootstrap. Tie that ordering to code.
  const cliDir = join(repoRoot, 'src', 'cli');

  it('node-version-guard.ts has no top-level side effect (import-safe for tests)', () => {
    const src = readFileSync(join(cliDir, 'node-version-guard.ts'), 'utf-8');
    // No bare top-level `assertSupportedNode();` call in the pure module.
    expect(/^\s*assertSupportedNode\(\);/m.test(src)).toBe(false);
  });

  it('the bootstrap runs the guard as its side effect', () => {
    const boot = readFileSync(join(cliDir, 'node-version-bootstrap.ts'), 'utf-8');
    expect(boot).toMatch(/assertSupportedNode\(\);/);
  });

  it('index.ts imports the bootstrap first — before commander', () => {
    const idx = readFileSync(join(cliDir, 'index.ts'), 'utf-8');
    const imports = [...idx.matchAll(/^import\s.*$/gm)].map((m) => m[0]);
    expect(imports[0], 'first import must be the node-version bootstrap').toMatch(/node-version-bootstrap/);
    const bootIdx = idx.indexOf('node-version-bootstrap');
    const commanderIdx = idx.indexOf("from 'commander'");
    expect(bootIdx).toBeGreaterThanOrEqual(0);
    expect(bootIdx).toBeLessThan(commanderIdx);
  });
});

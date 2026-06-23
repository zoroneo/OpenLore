/**
 * Guard for the Node-version floor. Two things must hold:
 *   1. checkNodeVersion() classifies versions correctly around the floor, and
 *   2. the floor stays coherent with package.json `engines.node` — so the guard's
 *      message can never promise a different minimum than the package declares.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkNodeVersion, MIN_NODE, EXIT_UNSUPPORTED_NODE } from './node-version-guard.js';

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
});

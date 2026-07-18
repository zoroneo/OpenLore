/**
 * Drift guard — one default, said once (change: fix-default-preset-claims;
 * cli spec: DefaultPresetHasOneSource).
 *
 * ADR-0023 flipped the out-of-box MCP default to `substrate` via the single
 * source-of-truth constant `LEAN_DEFAULT_PRESET`. This test makes that
 * single-source contract executable so the default can never fork across
 * entry points again:
 *
 *   1. Every entry point that resolves a preset when none is given — the MCP
 *      stdio server (`resolvePresetName`) and the HTTP daemon (`serve --preset`
 *      commander default) — resolves through the constant, not a literal.
 *   2. No entry-point source (`mcp.ts`, `serve.ts`, `connect.ts`, and the
 *      install adapter) reintroduces a hardcoded preset-name literal as a `??`
 *      fallback default.
 *   3. User-facing `--help` text that names the default preset derives the name
 *      from the constant (never a hardcoded string), so a future benchmark-gated
 *      flip that changes the constant re-labels the help automatically.
 *
 * If any of those regress, this test fails — by design.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { LEAN_DEFAULT_PRESET, FULL_PRESET, FULL_PRESET_ALIAS } from '../../constants.js';
import { mcpCommand, resolvePresetName, TOOL_PRESETS } from './mcp.js';
import { serveCommand } from './serve.js';
import { connectCommand } from './connect.js';
import { installCommand } from '../install/index.js';

// This test file lives at src/cli/commands/; the repo src root is two levels up.
const SRC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel: string) => readFileSync(join(SRC_ROOT, rel), 'utf-8');

/** The preset-name literals that must never be hardcoded as a fallback default. */
const PRESET_LITERALS = [...Object.keys(TOOL_PRESETS), FULL_PRESET, FULL_PRESET_ALIAS];

const optDesc = (cmd: { options: readonly { long?: string; description: string }[] }, long: string): string =>
  cmd.options.find(o => o.long === long)!.description;

describe('default preset — one source, said once (fix-default-preset-claims)', () => {
  it('the constant is what ADR-0023 selected (sanity anchor)', () => {
    // The whole guard is only meaningful because this is the ONE source of truth.
    expect(LEAN_DEFAULT_PRESET).toBe('substrate');
  });

  it('the MCP stdio server resolves the no-selector default through the constant', () => {
    expect(resolvePresetName({})).toBe(LEAN_DEFAULT_PRESET);
  });

  it('`openlore serve --preset` defaults to the constant, not a literal', () => {
    const opt = serveCommand.options.find(o => o.long === '--preset')!;
    // commander stores the default value it was constructed with; it must be the
    // constant's VALUE, and the code must not have hardcoded a different preset.
    expect(opt.defaultValue).toBe(LEAN_DEFAULT_PRESET);
  });

  it('no entry-point source hardcodes a preset-name literal as a `??` fallback default', () => {
    const files = [
      'cli/commands/mcp.ts',
      'cli/commands/serve.ts',
      'cli/commands/connect.ts',
      'cli/install/adapters/claude-code.ts',
    ];
    for (const rel of files) {
      const src = read(rel);
      for (const literal of PRESET_LITERALS) {
        // The one anti-pattern: `?? 'navigation'` (a literal fallback default).
        // A preset name mentioned in prose/help text is fine; a `??`-guarded
        // literal is a second source of truth and is not.
        const antiPattern = new RegExp(`\\?\\?\\s*['"]${literal}['"]`);
        expect(
          antiPattern.test(src),
          `${rel} uses a hardcoded '${literal}' as a ?? fallback default — resolve through LEAN_DEFAULT_PRESET instead`,
        ).toBe(false);
      }
    }
  });

  it('help text that names the default derives it from the constant (mcp/install/connect)', () => {
    for (const [name, cmd] of [['mcp', mcpCommand], ['install', installCommand], ['connect', connectCommand]] as const) {
      const help = optDesc(cmd, '--preset');
      // The active default's name must appear...
      expect(help, `${name} --preset help must name the "${LEAN_DEFAULT_PRESET}" default`).toContain(LEAN_DEFAULT_PRESET);
      // ...and the help must NOT claim the OLD default (navigation) is the default.
      // (navigation is still named — as the lean escape — so we match the specific
      // "default ... navigation surface" claim, not any mention of the word.)
      expect(
        /default[^.]{0,40}navigation surface/i.test(help),
        `${name} --preset help still calls navigation the default`,
      ).toBe(false);
    }
  });

  it('`openlore serve --preset` help states the constant as the default', () => {
    const help = optDesc(serveCommand, '--preset');
    expect(help).toContain(`Default: ${LEAN_DEFAULT_PRESET}`);
  });
});

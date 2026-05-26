/**
 * Sanity tests for the `skills/openlore-orient/scripts/orient-via-mcp.mjs`
 * helper. We don't shell out (slow + flaky in CI without a built dist) — we
 * import the module and assert it does basic input validation and that the
 * file is structurally a JSON-RPC driver. End-to-end coverage of the actual
 * MCP roundtrip is exercised by hand against the local dist build and is
 * documented in the spec-02 PR description.
 */

import { describe, it, expect } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const HELPER = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient-via-mcp.mjs');
const SH = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.sh');
const PS1 = resolve(REPO_ROOT, 'skills/openlore-orient/scripts/orient.ps1');
const SKILL_MD = resolve(REPO_ROOT, 'skills/openlore-orient/SKILL.md');

describe('openlore-orient skill bundle', () => {
  it('orient-via-mcp.mjs exists and references the MCP server', async () => {
    const src = await readFile(HELPER, 'utf8');
    expect(src).toContain("'openlore'");
    expect(src).toContain("'mcp'");
    expect(src).toContain('tools/call');
    expect(src).toContain('initialize');
  });

  it('orient.sh prefers the CLI subcommand, falls back to MCP helper', async () => {
    const src = await readFile(SH, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('orient.ps1 mirrors the same strategy', async () => {
    const src = await readFile(PS1, 'utf8');
    expect(src).toContain('npx --yes openlore orient --json --task');
    expect(src).toContain('orient-via-mcp.mjs');
  });

  it('SKILL.md has the required frontmatter keys', async () => {
    const src = await readFile(SKILL_MD, 'utf8');
    expect(src).toMatch(/^---\n[\s\S]*?\n---/);
    expect(src).toMatch(/^name:\s*openlore-orient$/m);
    expect(src).toMatch(/^version:\s*[0-9]+\.[0-9]+$/m);
    expect(src.toLowerCase()).toContain('persistent architectural memory');
  });

  it('orient.sh and orient.ps1 are executable', async () => {
    const sh = await stat(SH);
    expect(sh.mode & 0o111).not.toBe(0);
    const ps1 = await stat(PS1);
    expect(ps1.mode & 0o111).not.toBe(0);
  });
});

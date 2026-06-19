/**
 * Guard: the user-facing "N tools" full-surface count in the docs must match the
 * real `TOOL_DEFINITIONS.length`. The count drifted silently before (docs said 50
 * while the surface grew to 58) because nothing tied the prose to the code. This
 * ties them: add or remove a tool and the doc count must move with it, or CI fails.
 *
 * Scope is deliberately limited to the two current-tense surfaces a user reads to
 * learn the live tool count — README.md and docs/mcp-tools.md. In BOTH of those
 * files every `<N> tools` mention refers to the full surface, so the check is exact.
 * Dated point-in-time spec records under docs/specs/** are intentionally excluded:
 * "Spec 28 measured 50 tools / 47,037 bytes" is a historical measurement, not a
 * claim about today, and rewriting it would falsify the record.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TOOL_DEFINITIONS, toolAnnotations } from './mcp.js';

// src/cli/commands/<this> → repo root is three levels up.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Files whose every "<N> tools" mention is the live full surface. cli-reference.md
// is included: its sole "<N> tools" mention ("all <count> tools on a fixed port") is the
// full `serve --preset all` surface, so the exact check holds there too.
const GUARDED_DOCS = ['README.md', 'docs/mcp-tools.md', 'docs/cli-reference.md'];

describe('documented MCP tool count', () => {
  const expected = TOOL_DEFINITIONS.length;

  it.each(GUARDED_DOCS)('the "N tools" full-surface count in %s matches TOOL_DEFINITIONS.length', (rel) => {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    // "58 tools", and also "58 MCP tools" / "58 graph-native tools" — one optional
    // adjective word is allowed between the count and "tools" (those phrasings drifted
    // to a stale "50" once precisely because a bare `\d+\s+tools` regex skipped them).
    // Still excludes "7-tool" (hyphenated preset sizes) and "tool-calls" (no plural).
    const counts = [...text.matchAll(/(\d+)\s+(?:[A-Za-z][\w-]*\s+)?tools\b/g)].map(m => Number(m[1]));
    expect(counts.length, `expected at least one "N tools" mention in ${rel}`).toBeGreaterThan(0);
    for (const n of counts) {
      expect(n, `${rel} cites "${n} tools" but the live surface is ${expected}; update the doc (and the byte/token figures) when the tool count changes`).toBe(expected);
    }
  });
});

// The byte/token figures next to the tool count drifted too: docs cited "~48 KB /
// ~12k tokens" long after the real `tools/list` payload grew to ~55 KB / ~14k, because
// the count guard above only checks the integer, not the size figures. This ties the
// documented `~N KB` / `~Nk tokens` of the full `tools/list` line to the payload the
// ListTools handler actually emits (schemas + annotations), within a rounding band.
describe('documented tools/list size figures track the real payload', () => {
  // Mirror what the ListTools handler emits: each tool's schema plus its annotations.
  const tools = TOOL_DEFINITIONS.map(t => ({ ...t, annotations: toolAnnotations(t.name) }));
  const bytes = Buffer.byteLength(JSON.stringify({ tools }), 'utf8');
  const kb = bytes / 1024;
  const ktokens = bytes / 4 / 1000; // the ~bytes/4 token heuristic the docs use

  it('the "~N KB / ~Nk tokens of tools/list" figure in docs/mcp-tools.md is current', () => {
    const text = readFileSync(join(repoRoot, 'docs/mcp-tools.md'), 'utf8');
    const line = text.split('\n').find(l => /tools\/list/.test(l) && /~\d+\s*KB/.test(l));
    expect(line, 'expected a "~N KB … tools/list" figure line in docs/mcp-tools.md').toBeDefined();
    const docKb = Number(/~(\d+)\s*KB/.exec(line!)?.[1]);
    const docKtokens = Number(/~(\d+)k\s+tokens/.exec(line!)?.[1]);
    // ±3 KB / ±2k tokens absorbs rounding but catches a real drift (the stale figure
    // was 7 KB / 2k tokens light — well outside the band).
    expect(Math.abs(docKb - kb), `docs/mcp-tools.md cites ~${docKb} KB but the real tools/list payload is ~${kb.toFixed(1)} KB`).toBeLessThanOrEqual(3);
    expect(Math.abs(docKtokens - ktokens), `docs/mcp-tools.md cites ~${docKtokens}k tokens but the real payload is ~${ktokens.toFixed(1)}k tokens`).toBeLessThanOrEqual(2);
  });
});

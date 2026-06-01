/**
 * Spec 14 — MCP tool-preset selection (`--preset` / `--minimal`).
 *
 * Guards the navigation preset that flipped the agent benchmark from a loss to a
 * win: it must expose exactly its graph-traversal tools, every preset name must
 * resolve to a REAL tool (so a renamed/removed tool can't silently shrink the
 * surface), and the selector's precedence/error behaviour must hold.
 */
import { describe, it, expect } from 'vitest';
import { selectActiveTools, TOOL_PRESETS, TOOL_DEFINITIONS } from './mcp.js';

const NAV = [
  'orient', 'search_code', 'get_subgraph', 'trace_execution_path',
  'analyze_impact', 'suggest_insertion_points', 'get_function_skeleton',
];

describe('MCP tool presets', () => {
  it('every preset references only real, defined tools (no stale names)', () => {
    const real = new Set(TOOL_DEFINITIONS.map(t => t.name));
    for (const [name, set] of Object.entries(TOOL_PRESETS)) {
      for (const tool of set) {
        expect(real.has(tool), `preset "${name}" references unknown tool "${tool}"`).toBe(true);
      }
    }
  });

  it('navigation preset = exactly the 7 graph-traversal tools, no governance tools', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { preset: 'navigation' }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(NAV));
    for (const gov of ['record_decision', 'detect_changes', 'check_spec_drift']) {
      expect(tools).not.toContain(gov);
    }
  });

  it('minimal preset keeps its 5-tool contract', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { minimal: true }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(['orient', 'search_code', 'record_decision', 'detect_changes', 'check_spec_drift']));
  });

  it('no selector exposes the full tool set', () => {
    expect(selectActiveTools(TOOL_DEFINITIONS, {})).toHaveLength(TOOL_DEFINITIONS.length);
    expect(TOOL_DEFINITIONS.length).toBeGreaterThan(NAV.length); // full surface really is larger
  });

  it('--preset takes precedence over --minimal', () => {
    const tools = selectActiveTools(TOOL_DEFINITIONS, { minimal: true, preset: 'navigation' }).map(t => t.name);
    expect(new Set(tools)).toEqual(new Set(NAV));
  });

  it('an unknown preset throws with the known list, not a silent full surface', () => {
    expect(() => selectActiveTools(TOOL_DEFINITIONS, { preset: 'nope' })).toThrow(/Unknown --preset "nope".*minimal.*navigation/s);
  });
});

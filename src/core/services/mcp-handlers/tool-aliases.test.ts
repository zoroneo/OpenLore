/**
 * Tool-name alias + naming-consistency guards (change: refine-happy-path-and-defaults /
 * ConsistentToolNaming).
 *
 * Renaming a tool for consistency must NEVER break an existing caller: the prior
 * name keeps working as a permanent alias resolving to the same canonical tool.
 * These tests lock that contract — every alias targets a real tool, no alias
 * shadows a live name, resolution is a pure passthrough for unknown names — and
 * enforce the naming conventions on the surface (snake_case; the inventory family
 * shares the `_inventory` suffix) so the catalogued inconsistency cannot regress.
 *
 * The registered-tool set is taken from TOOL_OUTPUT_CLASS, which `tool-contract.test.ts`
 * already proves is exactly the live TOOL_DEFINITIONS — so this test needs no heavy
 * import of the MCP server module.
 */

import { describe, it, expect } from 'vitest';
import {
  TOOL_OUTPUT_CLASS,
  TOOL_NAME_ALIASES,
  resolveCanonicalToolName,
} from './tool-contract.js';

const REGISTERED = new Set(Object.keys(TOOL_OUTPUT_CLASS));
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

describe('tool-name aliases', () => {
  it('every alias targets a registered canonical tool', () => {
    for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
      expect(REGISTERED.has(canonical), `alias "${alias}" → "${canonical}" which is not a registered tool`).toBe(true);
    }
  });

  it('no alias collides with a live (registered) tool name', () => {
    // An alias must be a RETIRED name — never one that currently resolves to a tool,
    // or a call to the live name would be silently rewritten.
    for (const alias of Object.keys(TOOL_NAME_ALIASES)) {
      expect(REGISTERED.has(alias), `alias "${alias}" collides with a registered tool name`).toBe(false);
    }
  });

  it('resolveCanonicalToolName maps an alias to its canonical name', () => {
    expect(resolveCanonicalToolName('get_ui_components')).toBe('get_ui_component_inventory');
  });

  it('resolveCanonicalToolName is a passthrough for canonical and unknown names', () => {
    expect(resolveCanonicalToolName('orient')).toBe('orient');
    expect(resolveCanonicalToolName('get_ui_component_inventory')).toBe('get_ui_component_inventory');
    expect(resolveCanonicalToolName('totally_unknown_tool')).toBe('totally_unknown_tool');
  });
});

describe('tool naming conventions (ConsistentToolNaming)', () => {
  it('every registered tool name is snake_case', () => {
    for (const name of REGISTERED) {
      expect(SNAKE_CASE.test(name), `tool "${name}" is not snake_case`).toBe(true);
    }
  });

  it('every alias name is snake_case', () => {
    for (const alias of Object.keys(TOOL_NAME_ALIASES)) {
      expect(SNAKE_CASE.test(alias), `alias "${alias}" is not snake_case`).toBe(true);
    }
  });

  it('the inventory-retriever family shares the `_inventory` suffix', () => {
    // route / middleware / schema / ui_component inventories are siblings and must
    // share a suffix; `get_ui_components` (the prior odd-one-out) is reconciled to
    // `get_ui_component_inventory` and kept working via the alias above.
    const inventorySiblings = ['get_route_inventory', 'get_middleware_inventory', 'get_schema_inventory', 'get_ui_component_inventory'];
    for (const name of inventorySiblings) {
      expect(REGISTERED.has(name), `expected inventory sibling "${name}" to be registered`).toBe(true);
      expect(name.endsWith('_inventory'), `inventory sibling "${name}" must end with _inventory`).toBe(true);
    }
    // The reconciled prior name is no longer a live tool (only an alias).
    expect(REGISTERED.has('get_ui_components')).toBe(false);
  });
});

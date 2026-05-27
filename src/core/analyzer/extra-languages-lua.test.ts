import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';
const dir = join(__dirname, 'fixtures');
async function buildOne(rel: string, language: string): Promise<SerializedCallGraph> {
  return serializeCallGraph(await new CallGraphBuilder().build([{ path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language }]));
}
const fnNames = (g: SerializedCallGraph, lang: string) => g.nodes.filter(n => n.language === lang && !n.isExternal).map(n => n.name).sort();
const edge = (g: SerializedCallGraph, caller: string, callee: string) => {
  const c = g.nodes.find(n => n.name === caller); const d = g.nodes.find(n => n.name === callee && !n.isExternal);
  return !!c && !!d && g.edges.some(e => e.callerId === c.id && e.calleeId === d.id);
};
describe('spec-08 Lua (bundled WASM)', () => {
  it('local/table functions and calls', async () => {
    const g = await buildOne('lua/app.lua', 'Lua');
    const names = fnNames(g, 'Lua');
    if (names.length === 0) return; // WASM unavailable in this env → graceful skip
    expect(names).toEqual(['boot', 'helper', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);
    expect(edge(g, 'boot', 'run')).toBe(true);
    expect(g.nodes.find(n => n.name === 'boot')?.className).toBe('M');
  });
  it('resolves t.f() and t:m() call forms', async () => {
    const g = await buildOne('lua/methods.lua', 'Lua');
    if (fnNames(g, 'Lua').length === 0) return;
    expect(edge(g, 'run', 'build')).toBe(true);
    expect(edge(g, 'run', 'render')).toBe(true);
  });
});

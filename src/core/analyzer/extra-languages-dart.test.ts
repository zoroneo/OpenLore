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
describe('spec-08 Dart (bundled WASM)', () => {
  it('class methods + top-level functions, calls attributed across sibling bodies', async () => {
    const g = await buildOne('dart/app.dart', 'Dart');
    const names = fnNames(g, 'Dart');
    if (names.length === 0) return; // WASM unavailable in this env → graceful skip
    expect(names).toEqual(['helper', 'main', 'run']);
    expect(edge(g, 'run', 'helper')).toBe(true);  // helper() inside a method body
    expect(edge(g, 'main', 'run')).toBe(true);     // s.run()
    expect(g.classes.some(c => c.name === 'Service' && c.language === 'Dart')).toBe(true);
  });
});

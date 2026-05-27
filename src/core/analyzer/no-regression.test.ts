import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from './call-graph.js';

const dir = join(__dirname, 'fixtures');

/** Stable, normalized projection of a graph for snapshotting (order-independent). */
function normalize(g: SerializedCallGraph) {
  return {
    nodes: g.nodes
      .filter(n => !n.isExternal)
      .map(n => ({ id: n.id, name: n.name, className: n.className ?? null, language: n.language }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: g.edges
      .filter(e => !e.kind || e.kind === 'calls')
      .map(e => `${e.callerId} -> ${e.calleeId}`)
      .sort(),
    classes: g.classes
      .map(c => ({ id: c.id, name: c.name, methodIds: [...c.methodIds].sort() }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

async function buildTs(rel: string): Promise<SerializedCallGraph> {
  return serializeCallGraph(await new CallGraphBuilder().build([
    { path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language: 'TypeScript' },
  ]));
}

describe('spec-08 no-regression — TypeScript extraction is unperturbed', () => {
  // Locks the existing TypeScript extraction output. Adding the spec-08 language
  // dispatch branches must not change any existing-language path; any diff here
  // means an existing extractor was perturbed (the repo itself is TypeScript).
  it('matches the committed TypeScript graph snapshot', async () => {
    const g = await buildTs('regression/sample.ts');
    expect(normalize(g)).toMatchSnapshot();
  });

  it('is byte-identical across rebuilds (determinism)', async () => {
    const a = JSON.stringify(normalize(await buildTs('regression/sample.ts')));
    const b = JSON.stringify(normalize(await buildTs('regression/sample.ts')));
    expect(a).toBe(b);
  });
});

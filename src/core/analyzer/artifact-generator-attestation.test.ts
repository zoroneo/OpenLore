/**
 * Build-side integration for the index integrity attestation: drives the REAL
 * `writeEdgesToSQLite` persist pipeline and asserts the attestation it writes reconciles
 * one-to-one with the store it just persisted (change: add-index-integrity-attestation).
 *
 * This is the regression guard for the dogfood-caught bug: the attestation must count the
 * SAME production population the load recounts — internal (non-external), non-test nodes —
 * not the raw committed set. Counting external/test nodes would inflate `committed` and
 * falsely flag a freshly-built index as `degraded`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeEdgesToSQLite } from './artifact-generator.js';
import { readAttestation, reconcile } from './index-attestation.js';
import { EdgeStore, SCHEMA_VERSION } from '../services/edge-store.js';
import type { SerializedCallGraph, FunctionNode, CallEdge, ClassNode } from './call-graph.js';

function node(id: string, filePath: string, extra: Partial<FunctionNode> = {}): FunctionNode {
  return { id, name: id.split('::')[1] ?? id, filePath, isAsync: false, language: 'TypeScript', startIndex: 0, endIndex: 1, fanIn: 0, fanOut: 0, ...extra };
}

function graphWithMixedNodes(): SerializedCallGraph {
  const internal = [node('src/a.ts::fa', 'src/a.ts'), node('src/a.ts::fb', 'src/a.ts'), node('src/b.ts::fc', 'src/b.ts')];
  const external = node('ext::lib', 'node_modules/lib.ts', { isExternal: true });
  const test = node('src/a.test.ts::t1', 'src/a.test.ts', { isTest: true });
  const cls: ClassNode = { id: 'src/a.ts::C', name: 'C', filePath: 'src/a.ts', language: 'TypeScript', parentClasses: [], interfaces: [], methodIds: [], fanIn: 0, fanOut: 0, isModule: false };
  const edges: CallEdge[] = [
    { callerId: 'src/a.ts::fa', calleeId: 'src/a.ts::fb', calleeName: 'fb', confidence: 'import' }, // prod
    { callerId: 'src/a.ts::fb', calleeId: 'src/b.ts::fc', calleeName: 'fc', confidence: 'import' }, // prod
    { callerId: 'src/a.test.ts::t1', calleeId: 'src/a.ts::fa', calleeName: 'fa', confidence: 'import' }, // test caller — excluded
    { callerId: 'src/a.ts::fa', calleeId: 'src/a.test.ts::t1', calleeName: 't1', kind: 'tested_by', confidence: 'import' }, // tested_by — excluded
  ];
  return {
    nodes: [...internal, external, test], edges, classes: [cls], inheritanceEdges: [],
    hubFunctions: [], entryPoints: [], layerViolations: [],
    stats: { totalNodes: 5, totalEdges: edges.length, avgFanIn: 0, avgFanOut: 0 },
  };
}

describe('build-side attestation (writeEdgesToSQLite)', () => {
  const dirs: string[] = [];
  const tmp = async (): Promise<string> => { const d = await mkdtemp(join(tmpdir(), 'att-build-')); dirs.push(d); return d; };
  afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });

  it('writes an attestation counting internal/non-test nodes only, reconciling with the store', async () => {
    const dir = await tmp();
    const dbPath = EdgeStore.dbPath(dir);
    await writeEdgesToSQLite(graphWithMixedNodes(), dbPath);

    const att = await readAttestation(dir);
    expect(att).not.toBeNull();
    expect(att!.schemaVersion).toBe(SCHEMA_VERSION);
    // 3 internal functions (external + test excluded); 2 prod edges (test-endpoint + tested_by excluded);
    // 1 class; 2 distinct internal files (src/a.ts, src/b.ts).
    expect(att!.committed).toEqual({ files: 2, functions: 3, edges: 2, classes: 1 });

    // The build-side attestation reconciles HEALTHY against the store it just wrote — the
    // populations match by construction (this is the regression guard for the count bug).
    const store = EdgeStore.open(dbPath);
    try {
      const verdict = reconcile(att!, {
        schemaVersion: store.getSchemaVersion(),
        files: store.countFiles(), functions: store.countNodes(),
        edges: store.countEdges(), classes: store.countClasses(),
      });
      expect(verdict.verdict).toBe('healthy');
      expect(store.countNodes()).toBe(att!.committed.functions);
      expect(store.countEdges()).toBe(att!.committed.edges);
      expect(store.countFiles()).toBe(att!.committed.files);
    } finally {
      store.close();
    }
  });

  it('is deterministic through the real pipeline — byte-identical attestation across two builds', async () => {
    const a = await tmp();
    const b = await tmp();
    await writeEdgesToSQLite(graphWithMixedNodes(), EdgeStore.dbPath(a));
    await writeEdgesToSQLite(graphWithMixedNodes(), EdgeStore.dbPath(b));
    expect(JSON.stringify(await readAttestation(a))).toBe(JSON.stringify(await readAttestation(b)));
  });
});

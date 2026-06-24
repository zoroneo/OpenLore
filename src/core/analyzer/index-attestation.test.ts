import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ATTESTATION_VERSION,
  DEGRADED_RATIO_FLOOR,
  SMALL_REPO_MIN_FUNCTIONS,
  computeAttestation,
  digestProductionGraph,
  reconcile,
  writeAttestation,
  readAttestation,
  type AttNode,
  type AttEdge,
  type AttClass,
  type IndexAttestation,
  type PersistedCounts,
} from './index-attestation.js';
import { ARTIFACT_INDEX_ATTESTATION } from '../../constants.js';

const SCHEMA = 8;

/** A production graph of `n` functions across `files` files, with a chain of edges. */
function makeGraph(n: number, files = 4): { nodes: AttNode[]; edges: AttEdge[]; classes: AttClass[] } {
  const nodes: AttNode[] = [];
  for (let i = 0; i < n; i++) {
    nodes.push({ id: `src/f${i % files}.ts::fn${i}`, filePath: `src/f${i % files}.ts` });
  }
  const edges: AttEdge[] = [];
  for (let i = 0; i + 1 < n; i++) {
    edges.push({ callerId: nodes[i].id, calleeId: nodes[i + 1].id, calleeName: `fn${i + 1}` });
  }
  const classes: AttClass[] = [{ id: 'src/f0.ts::C' }];
  return { nodes, edges, classes };
}

describe('index-attestation: computeAttestation', () => {
  it('counts distinct files, functions, edges, classes from the production set', () => {
    const { nodes, edges, classes } = makeGraph(10, 4);
    const att = computeAttestation(SCHEMA, nodes, edges, classes);
    expect(att.attestationVersion).toBe(ATTESTATION_VERSION);
    expect(att.schemaVersion).toBe(SCHEMA);
    expect(att.committed).toEqual({ files: 4, functions: 10, edges: 9, classes: 1 });
    expect(att.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic — byte-identical record across two builds of the same graph', () => {
    const a = computeAttestation(SCHEMA, ...Object.values(makeGraph(25)) as [AttNode[], AttEdge[], AttClass[]]);
    const b = computeAttestation(SCHEMA, ...Object.values(makeGraph(25)) as [AttNode[], AttEdge[], AttClass[]]);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('index-attestation: digestProductionGraph', () => {
  it('is order-independent (sorts before hashing)', () => {
    const { nodes, edges, classes } = makeGraph(8);
    const forward = digestProductionGraph(SCHEMA, nodes, edges, classes);
    const shuffled = digestProductionGraph(
      SCHEMA,
      [...nodes].reverse(),
      [...edges].reverse(),
      [...classes].reverse(),
    );
    expect(shuffled).toBe(forward);
  });

  it('changes when the schema version changes (the stamp is schema-pinned)', () => {
    const { nodes, edges, classes } = makeGraph(8);
    expect(digestProductionGraph(7, nodes, edges, classes))
      .not.toBe(digestProductionGraph(8, nodes, edges, classes));
  });

  it('changes when a node is dropped (tamper evidence)', () => {
    const { nodes, edges, classes } = makeGraph(8);
    const full = digestProductionGraph(SCHEMA, nodes, edges, classes);
    const dropped = digestProductionGraph(SCHEMA, nodes.slice(1), edges, classes);
    expect(dropped).not.toBe(full);
  });
});

describe('index-attestation: reconcile', () => {
  const att = computeAttestation(SCHEMA, ...Object.values(makeGraph(40)) as [AttNode[], AttEdge[], AttClass[]]);
  const persistedFrom = (over: Partial<PersistedCounts>): PersistedCounts => ({
    schemaVersion: SCHEMA, files: att.committed.files, functions: att.committed.functions,
    edges: att.committed.edges, classes: att.committed.classes, ...over,
  });

  it('healthy when counts reconcile and schema matches', () => {
    expect(reconcile(att, persistedFrom({})).verdict).toBe('healthy');
  });

  it('healthy when the store grew via incremental updates (ratio > 1)', () => {
    expect(reconcile(att, persistedFrom({ functions: att.committed.functions + 5, edges: att.committed.edges + 5 })).verdict)
      .toBe('healthy');
  });

  it('degraded when persisted production counts fall below the ratio floor', () => {
    const few = Math.floor(att.committed.functions * (DEGRADED_RATIO_FLOOR - 0.1));
    const v = reconcile(att, persistedFrom({ functions: few, edges: few }));
    expect(v.verdict).toBe('degraded');
    expect(v.detail).toMatch(/materially smaller/);
  });

  it('mismatched when the store schema version differs', () => {
    const v = reconcile(att, persistedFrom({ schemaVersion: SCHEMA - 1 }));
    expect(v.verdict).toBe('mismatched');
    expect(v.detail).toMatch(/schema version/);
  });

  it('mismatched dominates a degraded count (schema is the root cause)', () => {
    expect(reconcile(att, persistedFrom({ schemaVersion: SCHEMA - 1, functions: 0, edges: 0 })).verdict)
      .toBe('mismatched');
  });

  describe('small-repo exemption', () => {
    const small = computeAttestation(SCHEMA, ...Object.values(makeGraph(SMALL_REPO_MIN_FUNCTIONS - 5, 2)) as [AttNode[], AttEdge[], AttClass[]]);
    it('skips the ratio floor — a tiny repo with zero persisted is still healthy if schema matches', () => {
      expect(reconcile(small, { schemaVersion: SCHEMA, files: 0, functions: 0, edges: 0, classes: 0 }).verdict)
        .toBe('healthy');
    });
    it('but a schema mismatch is still mismatched even for a tiny repo', () => {
      expect(reconcile(small, { schemaVersion: SCHEMA - 1, files: 0, functions: 0, edges: 0, classes: 0 }).verdict)
        .toBe('mismatched');
    });
  });
});

describe('index-attestation: read/write round-trip', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'att-test-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('writes atomically and reads back an identical record', async () => {
    const att = computeAttestation(SCHEMA, ...Object.values(makeGraph(30)) as [AttNode[], AttEdge[], AttClass[]]);
    await writeAttestation(dir, att);
    const onDisk = JSON.parse(await readFile(join(dir, ARTIFACT_INDEX_ATTESTATION), 'utf-8')) as IndexAttestation;
    expect(onDisk).toEqual(att);
    expect(await readAttestation(dir)).toEqual(att);
  });

  it('returns null for an absent attestation (legacy index — unverifiable, never fabricated)', async () => {
    expect(await readAttestation(dir)).toBeNull();
  });

  it('returns null for a foreign attestationVersion (forward-compat: do not trust an unknown shape)', async () => {
    const att = computeAttestation(SCHEMA, ...Object.values(makeGraph(30)) as [AttNode[], AttEdge[], AttClass[]]);
    await writeAttestation(dir, { ...att, attestationVersion: ATTESTATION_VERSION + 99 });
    expect(await readAttestation(dir)).toBeNull();
  });
});

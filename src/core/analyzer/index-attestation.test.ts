import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
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
  refreshAttestationCounts,
  type AttNode,
  type AttEdge,
  type AttClass,
  type IndexAttestation,
  type PersistedCounts,
  type AttestationCountSource,
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

describe('index-attestation: readAttestation fails closed on malformed input', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'att-mal-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
  const writeRaw = (s: string) => writeFile(join(dir, ARTIFACT_INDEX_ATTESTATION), s);
  const base = computeAttestation(SCHEMA, ...Object.values(makeGraph(30)) as [AttNode[], AttEdge[], AttClass[]]);

  it('rejects a committed object with missing numeric fields (the NaN→false-healthy trap)', async () => {
    // The critical bug guard: `committed: {}` would make reconcile's ratio NaN, and
    // `NaN < floor === false` would silently fabricate `healthy`. readAttestation must
    // reject it as unverifiable instead.
    await writeRaw(JSON.stringify({ ...base, committed: {} }));
    expect(await readAttestation(dir)).toBeNull();
  });

  it('rejects a committed object whose counts are non-numeric', async () => {
    await writeRaw(JSON.stringify({ ...base, committed: { files: 'x', functions: null, edges: 1, classes: 1 } }));
    expect(await readAttestation(dir)).toBeNull();
  });

  it('rejects a JSON-serialized non-finite count (NaN/Infinity serialize to null → rejected)', async () => {
    // JSON.stringify turns NaN/Infinity into null; the numeric-field check rejects null.
    await writeRaw(JSON.stringify({ ...base, committed: { files: 1, functions: NaN, edges: 1, classes: 1 } }));
    expect(await readAttestation(dir)).toBeNull();
  });

  it('rejects a missing digest and a missing committed', async () => {
    const noDigest: Record<string, unknown> = { ...base };
    delete noDigest['digest'];
    await writeRaw(JSON.stringify(noDigest));
    expect(await readAttestation(dir)).toBeNull();
    const noCommitted: Record<string, unknown> = { ...base };
    delete noCommitted['committed'];
    await writeRaw(JSON.stringify(noCommitted));
    expect(await readAttestation(dir)).toBeNull();
  });

  it('rejects non-JSON garbage', async () => {
    await writeRaw('}{ not json');
    expect(await readAttestation(dir)).toBeNull();
  });

  it('rejects an oversized file without an unbounded read (mcp-security)', async () => {
    await writeRaw(JSON.stringify(base) + ' '.repeat(1024 * 1024 + 16));
    expect(await readAttestation(dir)).toBeNull();
  });
});

describe('index-attestation: verdict boundaries', () => {
  it('ratio EXACTLY at the floor is healthy; just below is degraded (strict `<`)', () => {
    const att = computeAttestation(SCHEMA, ...Object.values(makeGraph(100, 4)) as [AttNode[], AttEdge[], AttClass[]]);
    const atFloor = Math.round(att.committed.functions * DEGRADED_RATIO_FLOOR); // exactly 0.5×
    const p = (fns: number): PersistedCounts => ({ schemaVersion: SCHEMA, files: 4, functions: fns, edges: att.committed.edges, classes: 1 });
    expect(reconcile(att, p(atFloor)).verdict).toBe('healthy');     // ratio === floor, not < floor
    expect(reconcile(att, p(atFloor - 1)).verdict).toBe('degraded');
  });

  it('small-repo threshold: exactly at the minimum applies the floor; one below is exempt', () => {
    const atMin = computeAttestation(SCHEMA, ...Object.values(makeGraph(SMALL_REPO_MIN_FUNCTIONS, 2)) as [AttNode[], AttEdge[], AttClass[]]);
    const below = computeAttestation(SCHEMA, ...Object.values(makeGraph(SMALL_REPO_MIN_FUNCTIONS - 1, 2)) as [AttNode[], AttEdge[], AttClass[]]);
    const empty: PersistedCounts = { schemaVersion: SCHEMA, files: 0, functions: 0, edges: 0, classes: 0 };
    expect(reconcile(atMin, empty).verdict).toBe('degraded');  // floor active at the threshold
    expect(reconcile(below, empty).verdict).toBe('healthy');   // exempt one below
  });

  it('committed.edges === 0 does not divide-by-zero (edge ratio treated as satisfied)', () => {
    const nodes: AttNode[] = Array.from({ length: 30 }, (_, i) => ({ id: `src/a.ts::f${i}`, filePath: 'src/a.ts' }));
    const att = computeAttestation(SCHEMA, nodes, [], [{ id: 'src/a.ts::C' }]);
    expect(att.committed.edges).toBe(0);
    expect(reconcile(att, { schemaVersion: SCHEMA, files: 1, functions: 30, edges: 0, classes: 1 }).verdict).toBe('healthy');
  });
});

describe('index-attestation: refreshAttestationCounts (keeps the verdict honest under incremental edits)', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'att-refresh-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const store = (
    counts: { files: number; functions: number; edges: number; classes: number },
    schemaVersion = SCHEMA,
  ): AttestationCountSource => ({
    countFiles: () => counts.files, countNodes: () => counts.functions,
    countEdges: () => counts.edges, countClasses: () => counts.classes,
    getSchemaVersion: () => schemaVersion,
  });

  it('updates committed counts to the live store and preserves the build-time digest + schema', async () => {
    const built = computeAttestation(SCHEMA, ...Object.values(makeGraph(100, 5)) as [AttNode[], AttEdge[], AttClass[]]);
    await writeAttestation(dir, built);
    // Simulate the watcher deleting ~70% of nodes, then refreshing.
    await refreshAttestationCounts(dir, store({ files: 3, functions: 30, edges: 29, classes: 1 }));
    const after = await readAttestation(dir);
    expect(after?.committed).toEqual({ files: 3, functions: 30, edges: 29, classes: 1 });
    expect(after?.digest).toBe(built.digest);             // digest stamps the last full build, carried forward
    expect(after?.schemaVersion).toBe(built.schemaVersion); // schema carried forward, never re-stamped
    // The crux: a load now reconciles HEALTHY against the shrunken-but-current store,
    // instead of falsely `degraded` against the stale build-time counts.
    expect(reconcile(after!, { schemaVersion: SCHEMA, files: 3, functions: 30, edges: 29, classes: 1 }).verdict).toBe('healthy');
    // Without the refresh, the original attestation would have flagged this as degraded:
    expect(reconcile(built, { schemaVersion: SCHEMA, files: 3, functions: 30, edges: 29, classes: 1 }).verdict).toBe('degraded');
  });

  it('REFUSES to refresh across a schema boundary — never masks a mismatched verdict', async () => {
    // Attestation written at the OLD schema; the live store has been wiped+re-stamped to a NEW schema
    // (mid schema-bump rebuild). A refresh must NOT rewrite the schema to current and erase the drift.
    const oldSchema = SCHEMA - 1;
    const built = computeAttestation(oldSchema, ...Object.values(makeGraph(100, 5)) as [AttNode[], AttEdge[], AttClass[]]);
    await writeAttestation(dir, built);
    await refreshAttestationCounts(dir, store({ files: 3, functions: 30, edges: 29, classes: 1 }, SCHEMA));
    const after = await readAttestation(dir);
    expect(after?.schemaVersion).toBe(oldSchema);           // untouched
    expect(after?.committed).toEqual(built.committed);      // counts untouched too — refresh was skipped
    // So a load still sees the schema drift as `mismatched`:
    expect(reconcile(after!, { schemaVersion: SCHEMA, files: 3, functions: 30, edges: 29, classes: 1 }).verdict).toBe('mismatched');
  });

  it('no-ops when no attestation exists (a legacy/unverifiable index is never fabricated)', async () => {
    await refreshAttestationCounts(dir, store({ files: 1, functions: 1, edges: 0, classes: 0 }));
    expect(await readAttestation(dir)).toBeNull();
  });
});

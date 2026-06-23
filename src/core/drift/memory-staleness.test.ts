/**
 * Memory-staleness drift detection (change: add-code-anchored-memory-staleness).
 * Verifies detectMemoryStaleness emits memory-orphaned/memory-drifted findings
 * and that detectDrift folds them into its issues + summary + hasDrift.
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import { AnchorContext } from '../decisions/anchor-adapter.js';
import { detectMemoryStaleness, detectDrift } from './drift-detector.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { SpecMap, StructuralAnchor } from '../../types/index.js';

let root: string;
const SRC = 'export function target() {\n  return 1;\n}\n';

function node(filePath: string, name: string, startIndex: number, endIndex: number): FunctionNode {
  return { id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript', startIndex, endIndex, fanIn: 0, fanOut: 0 };
}

async function buildStore(nodes: FunctionNode[]): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes(nodes);
  store.close();
}

async function writeDecisions(decisions: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'decisions');
  await mkdir(dir, { recursive: true });
  const full = decisions.map((d) => ({
    status: 'approved', title: 'untitled', rationale: '', consequences: '', proposedRequirement: null,
    affectedDomains: [], affectedFiles: [], sessionId: 's', recordedAt: '2026-01-01T00:00:00Z',
    confidence: 'medium', syncedToSpecs: [], ...d,
  }));
  await writeFile(join(dir, 'pending.json'), JSON.stringify({ version: '1', sessionId: 's', updatedAt: '', decisions: full }), 'utf-8');
}

async function writeNotes(memories: Array<Record<string, unknown>>): Promise<void> {
  const dir = join(root, OPENLORE_DIR, 'memory');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'notes.json'), JSON.stringify({ version: '1', updatedAt: '', memories }), 'utf-8');
}

function emptySpecMap(): SpecMap {
  return { byDomain: new Map(), byFile: new Map(), domainCount: 0, totalMappedFiles: 0 };
}

/** Capture a fresh symbol anchor for `target` from the current store. */
async function freshTargetAnchor(): Promise<StructuralAnchor> {
  const ctx = AnchorContext.open(root)!;
  try {
    const a = ctx.resolveDecisionAnchors(['src/t.ts'], 'keep target pure').find((x) => x.symbolName === 'target');
    return a!;
  } finally {
    ctx.close();
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-stale-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 't.ts'), SRC, 'utf-8');
  await buildStore([node('src/t.ts', 'target', 0, Buffer.byteLength(SRC, 'utf-8'))]);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('detectMemoryStaleness', () => {
  it('returns [] when there is nothing stale', async () => {
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'fresh', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
  });

  it('flags an orphaned decision anchor as memory-orphaned (warning)', async () => {
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'about target', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);
    await buildStore([]); // target removed from the graph
    const issues = await detectMemoryStaleness(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('memory-orphaned');
    expect(issues[0].severity).toBe('warning');
    expect(issues[0].id).toBe('memory-orphaned:decision:d1');
  });

  it('flags a drifted decision anchor as memory-drifted (info)', async () => {
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'about target', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);
    const edited = 'export function target() {\n  return 42;\n}\n';
    await writeFile(join(root, 'src', 't.ts'), edited, 'utf-8');
    await buildStore([node('src/t.ts', 'target', 0, Buffer.byteLength(edited, 'utf-8'))]);
    const issues = await detectMemoryStaleness(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('memory-drifted');
    expect(issues[0].severity).toBe('info');
  });

  it('does NOT report a stale-region-only downgrade as memory-drifted (no false "code changed" claim)', async () => {
    // The decision's anchored code is byte-identical; its file was only marked
    // stale by a budget-exceeded incremental update. detectMemoryStaleness must
    // NOT claim the code changed — that drift is not real and self-heals
    // (fix-transitive-incremental-staleness).
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'about target', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);

    const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    const store = EdgeStore.open(EdgeStore.dbPath(dir));
    store.markFilesStale(['src/t.ts']);
    store.close();

    // Suppressed — no fabricated memory-drifted issue.
    expect(await detectMemoryStaleness(root)).toEqual([]);

    // But a GENUINE content change in the same (stale-marked) file IS still flagged.
    const edited = 'export function target() {\n  return 42;\n}\n';
    await writeFile(join(root, 'src', 't.ts'), edited, 'utf-8');
    const issues = await detectMemoryStaleness(root);
    expect(issues).toHaveLength(1);
    expect(issues[0].kind).toBe('memory-drifted');
  });

  it('flags an orphaned note anchor', async () => {
    await writeNotes([{ id: 'n1', kind: 'note', content: 'note about gone.ts', anchors: [{ filePath: 'src/gone.ts', contentHash: 'x' }], recordedAt: '2026-01-01T00:00:00Z' }]);
    const issues = await detectMemoryStaleness(root);
    expect(issues.some((i) => i.kind === 'memory-orphaned' && i.id === 'memory-orphaned:note:n1')).toBe(true);
  });

  it('ignores inactive decisions and unanchored memories', async () => {
    await writeDecisions([{ id: 'r1', status: 'rejected', title: 'rejected', affectedFiles: ['src/gone.ts'] }]);
    await writeNotes([{ id: 'n0', kind: 'note', content: 'unanchored', anchors: [], recordedAt: '2026-01-01T00:00:00Z' }]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
  });

  it('ignores invalidated (superseded) notes even when their anchored code is gone', async () => {
    // A retired note has left the authoritative set; staleness must not resurrect it.
    // (add-bitemporal-typed-memory-operations)
    await writeNotes([{
      id: 'n1', kind: 'note', content: 'note about gone.ts', recordedAt: '2026-01-01T00:00:00Z',
      anchors: [{ filePath: 'src/gone.ts', contentHash: 'x' }],
      invalidatedAt: '2026-01-02T00:00:00Z',
    }]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
  });

  it('returns [] when no analysis exists (unverifiable, never a false stale)', async () => {
    await rm(join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true, force: true });
    await writeDecisions([{ id: 'd1', title: 'about target', affectedFiles: ['src/gone.ts'] }]);
    expect(await detectMemoryStaleness(root)).toEqual([]);
  });
});

describe('detectDrift integration', () => {
  it('folds memory staleness into issues, summary, and hasDrift', async () => {
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'about target', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);
    await buildStore([]); // orphan it

    const result = await detectDrift({
      rootPath: root,
      specMap: emptySpecMap(),
      changedFiles: [],
      failOn: 'warning',
    });

    expect(result.summary.memoryOrphaned).toBe(1);
    expect(result.summary.memoryDrifted).toBe(0);
    expect(result.issues.some((i) => i.kind === 'memory-orphaned')).toBe(true);
    expect(result.hasDrift).toBe(true); // warning meets the failOn threshold
  });

  it('reports no memory drift when all anchors are fresh', async () => {
    const anchor = await freshTargetAnchor();
    await writeDecisions([{ id: 'd1', title: 'fresh', anchors: [anchor], affectedFiles: ['src/t.ts'] }]);
    const result = await detectDrift({ rootPath: root, specMap: emptySpecMap(), changedFiles: [], failOn: 'warning' });
    expect(result.summary.memoryOrphaned).toBe(0);
    expect(result.summary.memoryDrifted).toBe(0);
  });
});

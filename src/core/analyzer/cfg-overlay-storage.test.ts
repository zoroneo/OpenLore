/**
 * Integration tests for the CFG/def-use overlay's storage + serialization
 * contract (spec: add-intraprocedural-cfg-dataflow-overlay):
 *   - the overlay is persisted to the SQLite store, keyed by function id;
 *   - it is NOT present in the resident SerializedCallGraph;
 *   - a schema-version bump rebuilds the store with no migration;
 *   - a per-file delete removes only that file's overlay rows.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { CallGraphBuilder, serializeCallGraph } from './call-graph.js';
import { writeEdgesToSQLite } from './artifact-generator.js';
import { EdgeStore } from '../services/edge-store.js';

const TS_SRC = `
export function classify(n: number): string {
  let label = "zero";
  if (n > 0) {
    label = "pos";
  } else {
    label = "neg";
  }
  return label;
}

export function loopSum(items: number[]): number {
  let total = 0;
  for (const x of items) {
    total = total + x;
  }
  return total;
}
`;

async function buildAndStore(dir: string, files: Array<{ path: string; content: string; language: string }>) {
  const builder = new CallGraphBuilder();
  const result = await builder.build(files);
  const serialized = serializeCallGraph(result);
  const cfgs = result.cfgs
    ? Array.from(result.cfgs.entries()).map(([functionId, cfg]) => ({
        functionId,
        filePath: result.nodes.get(functionId)!.filePath,
        cfg,
      }))
    : undefined;
  const dbPath = join(dir, 'call-graph.db');
  await writeEdgesToSQLite(serialized, dbPath, undefined, cfgs);
  return { serialized, dbPath, cfgs };
}

describe('CFG overlay storage', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'cfg-overlay-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('persists a per-function overlay loadable from the store', async () => {
    const { dbPath } = await buildAndStore(dir, [{ path: 'a.ts', content: TS_SRC, language: 'TypeScript' }]);
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.hasCfgOverlay()).toBe(true);
      const cfg = store.getCfg('a.ts::classify');
      expect(cfg).toBeTruthy();
      expect(cfg!.blocks.some(b => b.kind === 'branch')).toBe(true);
      expect(cfg!.params).toContain('n');
      // label is written in both arms and read at the return → reaching def-use.
      expect(cfg!.defUse.some(e => e.variable === 'label')).toBe(true);

      const loop = store.getCfg('a.ts::loopSum');
      expect(loop!.edges.some(e => e.kind === 'back')).toBe(true);
    } finally {
      store.close();
    }
  });

  it('builds overlays for decorated Python functions (@property/@cached_property)', async () => {
    // The fn query binds @fn.node to the `decorated_definition` wrapper, which has
    // no `body` field; buildCfgFor must descend to the inner `function_definition`.
    const PY_DECO = [
      'class Service:',
      '    @property',
      '    def value(self):',
      '        x = self.compute()',
      '        return x + 1',
      '',
      '    def plain(self, a):',
      '        return a * 2',
    ].join('\n');
    const { dbPath } = await buildAndStore(dir, [{ path: 'm.py', content: PY_DECO, language: 'Python' }]);
    const store = EdgeStore.open(dbPath);
    try {
      const decorated = store.getCfg('m.py::Service.value');
      expect(decorated, 'decorated function must have an overlay').toBeTruthy();
      expect(decorated!.params).toContain('self');
      expect(decorated!.defUse.some(e => e.variable === 'x')).toBe(true);
      expect(store.getCfg('m.py::Service.plain')).toBeTruthy();
    } finally {
      store.close();
    }
  });

  it('Overlay is not in the resident serialized graph', async () => {
    const { serialized } = await buildAndStore(dir, [{ path: 'a.ts', content: TS_SRC, language: 'TypeScript' }]);
    // The resident shape carries nodes/edges/classes but no CFG/def-use overlay.
    expect('cfgs' in serialized).toBe(false);
    expect(JSON.stringify(serialized).includes('defUse')).toBe(false);
  });

  it('Schema bump rebuilds without migration (overlay survives a fresh analyze)', async () => {
    // Simulate a pre-overlay store: a stale schema version with a stray table.
    const dbPath = join(dir, 'call-graph.db');
    const old = new DatabaseSync(dbPath);
    old.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    old.prepare('INSERT INTO schema_version (version) VALUES (1)').run();
    old.exec('CREATE TABLE nodes (id TEXT)');
    old.prepare("INSERT INTO nodes (id) VALUES ('stale::ghost')").run();
    old.close();

    // The analyze/write path is the one allowed to rebuild-on-bump (a read never wipes).
    const reset = EdgeStore.openForAnalyze(dbPath);
    expect(reset.wasReset).toBe(true);
    reset.close();

    // A fresh analyze repopulates the overlay with no migration code.
    const { dbPath: dbPath2 } = await buildAndStore(dir, [{ path: 'a.ts', content: TS_SRC, language: 'TypeScript' }]);
    expect(dbPath2).toBe(dbPath);
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.getNode('stale::ghost')).toBeNull(); // old data gone
      expect(store.getCfg('a.ts::classify')).toBeTruthy(); // overlay present
    } finally {
      store.close();
    }
  });

  it('Single-file delete removes only that file\'s overlay rows', async () => {
    const { dbPath } = await buildAndStore(dir, [
      { path: 'a.ts', content: TS_SRC, language: 'TypeScript' },
      { path: 'b.ts', content: TS_SRC.replace(/classify/g, 'sort').replace(/loopSum/g, 'reduce'), language: 'TypeScript' },
    ]);
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.getCfg('a.ts::classify')).toBeTruthy();
      expect(store.getCfg('b.ts::sort')).toBeTruthy();
      store.deleteCfgForFile('a.ts');
      expect(store.getCfg('a.ts::classify')).toBeNull(); // removed
      expect(store.getCfg('b.ts::sort')).toBeTruthy();   // untouched
    } finally {
      store.close();
    }
  });

  it('getCfg returns null (never throws) on a corrupt overlay blob', async () => {
    const { dbPath } = await buildAndStore(dir, [
      { path: 'a.ts', content: TS_SRC, language: 'TypeScript' },
    ]);
    // Corrupt the stored JSON directly, then confirm the reader fails soft.
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE cfg_overlay SET cfg = '{not valid json' WHERE function_id = 'a.ts::classify'").run();
    raw.close();
    const store = EdgeStore.open(dbPath);
    try {
      expect(store.getCfg('a.ts::classify')).toBeNull(); // corrupt → null, no throw
    } finally {
      store.close();
    }
  });
});

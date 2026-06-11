/**
 * record_decision structural anchoring (change: add-code-anchored-memory-staleness).
 * Verifies a recorded decision captures symbol + file anchors against the call
 * graph, and degrades gracefully (unanchored) when no analysis exists.
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Background consolidation spawns a detached process — stub it out in tests.
vi.mock('node:child_process', () => ({ spawn: vi.fn(() => ({ unref: vi.fn() })) }));

import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EdgeStore } from '../edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../../constants.js';
import { handleRecordDecision } from './decisions.js';
import type { FunctionNode, } from '../../analyzer/call-graph.js';
import type { PendingDecision } from '../../../types/index.js';

let root: string;

const SRC = 'export function validateDirectory() {\n  return true;\n}\nexport function helper() {}\n';

function node(filePath: string, name: string, startIndex: number, endIndex: number): FunctionNode {
  return { id: `${filePath}::${name}`, name, filePath, isAsync: false, language: 'typescript', startIndex, endIndex, fanIn: 0, fanOut: 0 };
}

async function buildStore(): Promise<void> {
  const dir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  await mkdir(dir, { recursive: true });
  const store = EdgeStore.open(EdgeStore.dbPath(dir));
  store.clearAll();
  store.insertNodes([
    node('src/utils.ts', 'validateDirectory', 0, SRC.indexOf('}') + 1),
    node('src/utils.ts', 'helper', SRC.indexOf('export function helper'), Buffer.byteLength(SRC, 'utf-8')),
  ]);
  store.close();
}

async function readDecisions(): Promise<PendingDecision[]> {
  const raw = await readFile(join(root, OPENLORE_DIR, 'decisions', 'pending.json'), 'utf-8');
  return (JSON.parse(raw) as { decisions: PendingDecision[] }).decisions;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'openlore-recdec-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'utils.ts'), SRC, 'utf-8');
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('record_decision anchoring', () => {
  it('captures a symbol anchor for a function named in the decision text + a file anchor', async () => {
    await buildStore();
    await handleRecordDecision(
      root,
      'Harden validateDirectory against traversal',
      'validateDirectory must reject .. segments',
      undefined,
      ['src/utils.ts'],
    );
    const [d] = await readDecisions();
    expect(d.anchors).toBeDefined();
    const symbols = d.anchors!.filter((a) => a.nodeId);
    const files = d.anchors!.filter((a) => !a.nodeId);
    expect(symbols.map((a) => a.symbolName)).toContain('validateDirectory');
    expect(symbols.map((a) => a.symbolName)).not.toContain('helper'); // not mentioned
    expect(files.map((a) => a.filePath)).toEqual(['src/utils.ts']);
    expect(symbols[0].contentHash).toBeDefined();
  });

  it('captures only file anchors when no symbol is named', async () => {
    await buildStore();
    await handleRecordDecision(root, 'Refactor the utils module layout', 'general cleanup', undefined, ['src/utils.ts']);
    const [d] = await readDecisions();
    expect(d.anchors!.every((a) => !a.nodeId)).toBe(true);
    expect(d.anchors).toHaveLength(1);
  });

  it('records an unanchored decision when no analysis exists', async () => {
    // No edge store built.
    await handleRecordDecision(root, 'A decision without analysis', 'rationale', undefined, ['src/utils.ts']);
    const [d] = await readDecisions();
    expect(d.anchors).toBeUndefined();
  });

  it('records no anchors when affectedFiles is omitted', async () => {
    await buildStore();
    await handleRecordDecision(root, 'A fileless decision', 'rationale');
    const [d] = await readDecisions();
    expect(d.anchors).toBeUndefined();
  });
});

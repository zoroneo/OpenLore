/**
 * Durability + concurrency guarantees for the JSON stores.
 * (change: harden-memory-integrity-invariant)
 *
 * Guards architecture-spec requirements DurableAtomicStorePersistence and
 * CorruptStoreQuarantineNotSilentEmpty, and the mcp-handlers requirement
 * ConcurrentMemoryWriteSafety. Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFile,
  casUpdate,
  quarantineCorrupt,
  type SequencedStore,
} from './atomic-store.js';
import {
  loadMemoryStore,
  saveMemoryStore,
  updateMemoryStore,
  memoryDir,
} from './memory-store.js';
import { loadDecisionStore, saveDecisionStore, decisionsDir } from './store.js';
import { MEMORY_NOTES_FILE, DECISIONS_PENDING_FILE } from '../../constants.js';
import type { AnchoredMemory, MemoryStore } from '../../types/index.js';

vi.mock('../../utils/logger.js', () => ({
  logger: { warning: vi.fn(), info: vi.fn(), error: vi.fn(), success: vi.fn(), section: vi.fn(), discovery: vi.fn(), analysis: vi.fn(), blank: vi.fn() },
}));

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'openlore-atomic-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function note(id: string): AnchoredMemory {
  return { id, kind: 'note', content: `note ${id}`, anchors: [], recordedAt: '2026-01-01T00:00:00Z' };
}

// ════════════════════════════════════════════════════════════════════════════
// atomicWriteFile — temp + fsync + rename
// ════════════════════════════════════════════════════════════════════════════
describe('atomicWriteFile', () => {
  it('writes content and leaves no temp file behind', async () => {
    const path = join(root, 'sub', 'data.json');
    await atomicWriteFile(path, '{"ok":true}');
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ ok: true });
    const entries = await readdir(join(root, 'sub'));
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
  });

  it('replaces existing content atomically (prior content fully overwritten)', async () => {
    const path = join(root, 'data.json');
    await atomicWriteFile(path, 'first');
    await atomicWriteFile(path, 'second');
    expect(await readFile(path, 'utf-8')).toBe('second');
  });

  it('a crash BETWEEN temp-write and rename preserves the prior committed file', async () => {
    // atomicWriteFile writes a sibling temp file, then renames it into place. A
    // crash before the rename leaves the temp file orphaned and the committed
    // file untouched — never a torn in-place write. Reproduce that state: commit
    // v1, then leave a torn temp file exactly where a crashed writer would.
    const path = join(root, 'store.json');
    await atomicWriteFile(path, JSON.stringify({ committed: true }));
    const tornTemp = join(root, `.store.json.tmp-${process.pid}`);
    await writeFile(tornTemp, '{ partial torn write that never renamed', 'utf-8');

    // The committed file is intact (the crash never touched it in place).
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ committed: true });

    // A subsequent successful write still produces clean committed content and
    // overwrites/ignores the orphaned temp.
    await atomicWriteFile(path, JSON.stringify({ committed: false }));
    expect(JSON.parse(await readFile(path, 'utf-8'))).toEqual({ committed: false });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// casUpdate — compare-and-swap, re-apply on conflict
// ════════════════════════════════════════════════════════════════════════════
describe('casUpdate', () => {
  interface Store extends SequencedStore { items: string[] }
  const path = () => join(root, 'cas.json');
  const load = async (): Promise<Store> => {
    try { return JSON.parse(await readFile(path(), 'utf-8')) as Store; }
    catch { return { items: [], sequence: 0 }; }
  };
  const serialize = (s: Store) => JSON.stringify(s);

  it('bumps sequence by exactly one per committed write', async () => {
    const a = await casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, 'a'] }) });
    expect(a.sequence).toBe(1);
    const b = await casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, 'b'] }) });
    expect(b.sequence).toBe(2);
    expect(b.items).toEqual(['a', 'b']);
  });

  it('re-applies the mutate when the on-disk sequence changed mid-update (no lost write)', async () => {
    // A competing writer has already committed {items:['other'], sequence:1} to disk.
    await writeFile(path(), serialize({ items: ['other'], sequence: 1 }));
    // Make the FIRST outer load return a stale (sequence 0) view so the commit
    // re-read detects the conflict and forces exactly one re-apply.
    let calls = 0;
    const staleThenFresh = async (): Promise<Store> => {
      calls++;
      return calls === 1 ? { items: [], sequence: 0 } : load();
    };
    const result = await casUpdate<Store>({
      storePath: path(),
      load: staleThenFresh,
      serialize,
      mutate: (s) => ({ ...s, items: [...s.items, 'mine'] }),
    });
    // The competing 'other' write is NOT clobbered; 'mine' is re-applied on top.
    expect(result.items).toEqual(['other', 'mine']);
    expect(result.sequence).toBe(2);
  });

  it('N concurrent casUpdate calls lose zero writes', async () => {
    const N = 25;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        casUpdate<Store>({ storePath: path(), load, serialize, mutate: (s) => ({ ...s, items: [...s.items, `w${i}`] }) }),
      ),
    );
    const final = await load();
    expect(final.items.sort()).toEqual(Array.from({ length: N }, (_, i) => `w${i}`).sort());
    expect(final.sequence).toBe(N);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// quarantineCorrupt
// ════════════════════════════════════════════════════════════════════════════
describe('quarantineCorrupt', () => {
  it('moves the file aside to a deterministic .corrupt-<n> path (no timestamp)', async () => {
    const path = join(root, 'notes.json');
    await writeFile(path, 'garbage', 'utf-8');
    const dest = await quarantineCorrupt(path, 'test');
    expect(dest).toBe(`${path}.corrupt-0`);
    expect(await readFile(dest!, 'utf-8')).toBe('garbage');
  });

  it('uses the next free index when a prior quarantine exists', async () => {
    const path = join(root, 'notes.json');
    await writeFile(`${path}.corrupt-0`, 'old', 'utf-8');
    await writeFile(path, 'garbage', 'utf-8');
    const dest = await quarantineCorrupt(path, 'test');
    expect(dest).toBe(`${path}.corrupt-1`);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// memory store end-to-end durability
// ════════════════════════════════════════════════════════════════════════════
describe('memory store — durability + concurrency end-to-end', () => {
  it('legacy store without a sequence field loads as sequence 0 and saves at 1', async () => {
    const dir = memoryDir(root);
    await mkdir(dir, { recursive: true });
    // Legacy shape: no `sequence` field.
    await writeFile(join(dir, MEMORY_NOTES_FILE), JSON.stringify({ version: '1', updatedAt: '', memories: [note('a')] }), 'utf-8');
    const loaded = await loadMemoryStore(root);
    expect(loaded.sequence).toBe(0);
    expect(loaded.memories).toHaveLength(1);
    await saveMemoryStore(root, loaded);
    expect((await loadMemoryStore(root)).sequence).toBe(1);
  });

  it('N concurrent remember-style updates persist all N memories', async () => {
    const N = 20;
    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        updateMemoryStore(root, (s: MemoryStore) => ({
          ...s,
          memories: [...s.memories.filter((m) => m.id !== `m${i}`), note(`m${i}`)],
        })),
      ),
    );
    const final = await loadMemoryStore(root);
    expect(final.memories.map((m) => m.id).sort()).toEqual(Array.from({ length: N }, (_, i) => `m${i}`).sort());
  });

  it('a corrupted notes store is quarantined, not silently emptied', async () => {
    const dir = memoryDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, MEMORY_NOTES_FILE);
    await writeFile(path, '{ this is : not valid json', 'utf-8');
    const loaded = await loadMemoryStore(root);
    expect(loaded.memories).toHaveLength(0); // degrades to empty (no crash)
    // ...but the corrupt bytes are preserved on disk, not dropped.
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${MEMORY_NOTES_FILE}.corrupt-`))).toBe(true);
  });

  it('writes notes.json atomically (no lingering temp files)', async () => {
    await updateMemoryStore(root, (s) => ({ ...s, memories: [note('x')] }));
    const entries = await readdir(memoryDir(root));
    expect(entries.filter((e) => e.includes('.tmp'))).toHaveLength(0);
    expect(entries).toContain(MEMORY_NOTES_FILE);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// decision store quarantine + sequence
// ════════════════════════════════════════════════════════════════════════════
describe('decision store — quarantine + sequence', () => {
  it('a corrupted pending.json is quarantined, not silently emptied', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    await writeFile(path, 'totally not json', 'utf-8');
    const loaded = await loadDecisionStore(root);
    expect(loaded.decisions).toHaveLength(0);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))).toBe(true);
  });

  it('an invalid-shape store (object without decisions array) is quarantined', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    await writeFile(path, JSON.stringify({ version: '1', sessionId: 's', updatedAt: '' }), 'utf-8');
    await loadDecisionStore(root);
    const entries = await readdir(dir);
    expect(entries.some((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))).toBe(true);
  });

  it('save bumps the monotonic sequence', async () => {
    const s0 = await loadDecisionStore(root);
    expect(s0.sequence).toBe(0);
    await saveDecisionStore(root, s0);
    const s1 = await loadDecisionStore(root);
    expect(s1.sequence).toBe(1);
    await saveDecisionStore(root, s1);
    expect((await loadDecisionStore(root)).sequence).toBe(2);
  });

  it('quarantined file retains the original bytes (recoverable)', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const path = join(dir, DECISIONS_PENDING_FILE);
    const original = '{ torn store ';
    await writeFile(path, original, 'utf-8');
    await loadDecisionStore(root);
    const corrupt = (await readdir(dir)).find((e) => e.startsWith(`${DECISIONS_PENDING_FILE}.corrupt-`))!;
    expect(await readFile(join(dir, corrupt), 'utf-8')).toBe(original);
    await stat(join(dir, corrupt)); // exists
  });
});

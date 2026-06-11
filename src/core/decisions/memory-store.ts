/**
 * Anchored-memory (notes) store — CRUD for .openlore/memory/notes.json.
 * (change: add-code-anchored-memory-staleness)
 *
 * Deliberately separate from the decision store and commit gate: a `remember`
 * note is a durable, code-anchored fact, not an architectural decision, and must
 * never touch the consolidation/sync pipeline. Shared by the remember/recall
 * handlers and the memory-staleness drift detector.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { fileExists } from '../../utils/command-helpers.js';
import {
  OPENLORE_DIR,
  OPENLORE_MEMORY_SUBDIR,
  MEMORY_NOTES_FILE,
} from '../../constants.js';
import type { MemoryStore } from '../../types/index.js';

export function memoryDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_MEMORY_SUBDIR);
}

function emptyStore(): MemoryStore {
  return { version: '1', updatedAt: '', memories: [] };
}

export async function loadMemoryStore(rootPath: string): Promise<MemoryStore> {
  const path = join(memoryDir(rootPath), MEMORY_NOTES_FILE);
  if (!(await fileExists(path))) return emptyStore();
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<MemoryStore>;
    // Defend against a hand-edited / truncated store: a malformed file must not
    // crash recall or drift — fall back to empty, like the decision store does.
    if (!parsed || !Array.isArray(parsed.memories)) return emptyStore();
    return { version: '1', updatedAt: parsed.updatedAt ?? '', memories: parsed.memories };
  } catch (err) {
    logger.warning(
      `memory store: failed to read ${path} (${(err as Error).message}) — starting fresh`,
    );
    return emptyStore();
  }
}

export async function saveMemoryStore(rootPath: string, store: MemoryStore): Promise<void> {
  const dir = memoryDir(rootPath);
  await mkdir(dir, { recursive: true });
  const updated: MemoryStore = { ...store, updatedAt: new Date().toISOString() };
  await writeFile(join(dir, MEMORY_NOTES_FILE), JSON.stringify(updated, null, 2) + '\n', 'utf-8');
}

/** Stable 8-char id derived from recordedAt + content. */
export function makeMemoryId(content: string, recordedAt: string): string {
  return createHash('sha256').update(`${recordedAt}:${content}`).digest('hex').slice(0, 8);
}

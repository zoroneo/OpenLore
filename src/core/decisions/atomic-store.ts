/**
 * Durable, concurrency-safe persistence primitives for the JSON stores.
 * (change: harden-memory-integrity-invariant)
 *
 * OpenLore's promise — *never serve an unverified or stale fact as
 * authoritative* — is only as strong as the durability of the files behind it.
 * Both stores (`.openlore/memory/notes.json`, `.openlore/decisions/pending.json`)
 * are single JSON files rewritten in full. Without these primitives:
 *
 *   - a crash mid-write leaves a torn file that loads as a silent empty store
 *     (memory vanishes, nothing says so), and
 *   - two concurrent writers race: last-writer-wins silently drops the other.
 *
 * This module supplies three stdlib-only primitives (no new dependency, no LLM):
 *
 *   1. {@link atomicWriteFile} — write to a temp file, fsync, then POSIX-rename
 *      into place. A crash before the rename leaves the prior store intact.
 *   2. {@link casUpdate} — optimistic compare-and-swap on a monotonic `sequence`:
 *      load → mutate → commit only if the on-disk sequence is unchanged; on a
 *      conflict, re-read and re-apply the (append/supersede) merge rather than
 *      clobber. No concurrent write is lost.
 *   3. {@link quarantineCorrupt} — move a store that fails validation aside to
 *      `*.corrupt-<n>` and signal it, instead of silently substituting empty.
 */

import { open, rename, stat, unlink, mkdir, access } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { logger } from '../../utils/logger.js';

/** Any persisted store that carries the monotonic CAS counter. */
export interface SequencedStore {
  sequence?: number;
}

/**
 * Write `data` to `path` atomically. The data goes to a sibling temp file, is
 * flushed to disk (`fsync`), and is moved into place with a single atomic
 * `rename`. A crash or interruption before the rename leaves the previously
 * committed file untouched — never a partially written (torn) file.
 */
export async function atomicWriteFile(path: string, data: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // pid-scoped temp name: each writer holds the store lock during commit, but a
  // distinct name per process keeps concurrent best-effort writers from sharing a
  // temp file even outside the lock.
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data, 'utf-8');
    await fh.sync(); // durability barrier: bytes are on disk before the rename
  } finally {
    await fh.close();
  }
  await rename(tmp, path); // atomic replace
}

// ── advisory lock for the tiny compare-and-write commit section ───────────────

const LOCK_STALE_MS = 30_000; // steal a lock older than this (crashed holder)
const LOCK_POLL_MS = 25;
const LOCK_MAX_WAIT_MS = 30_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run `fn` while holding a per-file advisory lock (exclusive-create lockfile,
 * polled, with stale-steal for a crashed holder). The lock guards only the brief
 * compare-and-write commit, so contention is minimal. Best-effort on timeout: it
 * proceeds rather than block a writer forever (the CAS check still protects the
 * write from clobbering a committed change).
 */
async function withCommitLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lockPath), { recursive: true });
  const start = Date.now();
  for (;;) {
    try {
      const fh = await open(lockPath, 'wx'); // exclusive create — fails if held
      await fh.writeFile(`${process.pid}`);
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      if (Date.now() - start > LOCK_MAX_WAIT_MS) break; // best-effort
      await sleep(LOCK_POLL_MS);
    }
  }
  try {
    return await fn();
  } finally {
    await unlink(lockPath).catch(() => {});
  }
}

const MAX_CAS_ATTEMPTS = 50;

/**
 * Atomically read-modify-write a sequenced JSON store with optimistic
 * compare-and-swap. Loads the current store, applies `mutate`, and commits at
 * `sequence + 1` only if the on-disk sequence is still what was loaded; on a
 * conflict it re-reads and re-applies `mutate` to the newer store rather than
 * overwrite the competing write. Returns the committed store.
 *
 * `mutate` MUST be a pure merge over the loaded store (append / id-keyed
 * upsert / supersede) so that re-applying it after a conflict is correct.
 */
export async function casUpdate<T extends SequencedStore>(opts: {
  storePath: string;
  load: () => Promise<T>;
  mutate: (current: T) => T;
  serialize: (next: T) => string;
}): Promise<T> {
  const lockPath = `${opts.storePath}.lock`;
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const current = await opts.load();
    const baseSeq = current.sequence ?? 0;
    const next = { ...opts.mutate(current), sequence: baseSeq + 1 } as T;

    const committed = await withCommitLock(lockPath, async () => {
      const onDisk = await opts.load(); // re-read under the lock
      if ((onDisk.sequence ?? 0) !== baseSeq) return false; // conflict → re-apply
      await atomicWriteFile(opts.storePath, opts.serialize(next));
      return true;
    });
    if (committed) return next;
    // else: a competing writer advanced the sequence — loop, re-read, re-apply.
  }
  throw new Error(
    `casUpdate: exhausted ${MAX_CAS_ATTEMPTS} attempts on ${opts.storePath} (persistent write contention)`,
  );
}

// ── corrupt-store quarantine ──────────────────────────────────────────────────

async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

/**
 * Move a store that failed validation aside to a deterministic quarantine path
 * `${path}.corrupt-<n>` and emit a recoverable signal, instead of silently
 * substituting an empty store (which would present absence as current fact).
 *
 * The suffix is the first free non-negative integer — derived from what is
 * already on disk, never wall-clock time — so recovery is reproducible. Returns
 * the quarantine path, or `null` if the move could not be performed (in which
 * case the caller still degrades to empty, but loudly).
 */
export async function quarantineCorrupt(path: string, reason: string): Promise<string | null> {
  try {
    let n = 0;
    while (await exists(`${path}.corrupt-${n}`)) n++;
    const dest = `${path}.corrupt-${n}`;
    await rename(path, dest);
    logger.warning(
      `store quarantine: ${path} failed validation (${reason}) — moved to ${dest}. ` +
        `Persisted data was NOT silently dropped; inspect or restore the quarantined file.`,
    );
    return dest;
  } catch (err) {
    logger.warning(
      `store quarantine: ${path} failed validation (${reason}) and could not be moved aside ` +
        `(${(err as Error).message}). Starting from an empty store.`,
    );
    return null;
  }
}

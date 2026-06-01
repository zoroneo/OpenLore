/**
 * Cross-process advisory lock for the decision store (Spec 15 dogfood fix).
 *
 * `record_decision` spawns a detached `decisions --consolidate` per call. Under
 * rapid recording, several consolidations run at once; each does a
 * load → mutate → save of `pending.json`, and the later save clobbers the
 * earlier one — silently losing decisions (observed during the spec-15 dogfood:
 * 5 rapid records produced 3 stored decisions).
 *
 * Serializing consolidation behind this lock — and reloading the store *inside*
 * it — makes the read-modify-write safe: whoever holds the lock sees every draft
 * written so far, so nothing is lost.
 */
import { open, stat, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { decisionsDir } from './store.js';

const LOCK_FILE = '.consolidate.lock';
const STALE_MS = 120_000;     // steal a lock older than this (crashed/killed holder)
const POLL_MS = 150;
const MAX_WAIT_MS = 180_000;  // give up waiting after this and proceed best-effort

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Acquire the consolidation lock. Returns an idempotent release function.
 * Waits (polling) while another process holds it; steals a stale lock left by a
 * crashed holder. On the rare MAX_WAIT timeout it proceeds without the lock
 * rather than block a background process forever.
 */
export async function acquireDecisionsLock(rootPath: string): Promise<() => Promise<void>> {
  const dir = decisionsDir(rootPath);
  await mkdir(dir, { recursive: true });
  const lockPath = join(dir, LOCK_FILE);
  const start = Date.now();

  for (;;) {
    try {
      const fh = await open(lockPath, 'wx'); // exclusive create — fails if held
      await fh.writeFile(`${process.pid} ${new Date().toISOString()}`);
      await fh.close();
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await unlink(lockPath).catch(() => {});
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Held by someone else — steal if stale, else wait.
      try {
        const s = await stat(lockPath);
        if (Date.now() - s.mtimeMs > STALE_MS) {
          await unlink(lockPath).catch(() => {});
          continue; // retry acquire immediately
        }
      } catch {
        continue; // lock vanished between open and stat — retry acquire
      }
      if (Date.now() - start > MAX_WAIT_MS) {
        return async () => {}; // best-effort: proceed without the lock
      }
      await sleep(POLL_MS);
    }
  }
}

/** Run `fn` while holding the consolidation lock; always releases. */
export async function withDecisionsLock<T>(rootPath: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireDecisionsLock(rootPath);
  try {
    return await fn();
  } finally {
    await release();
  }
}

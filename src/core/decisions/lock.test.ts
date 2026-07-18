/**
 * Spec 15 dogfood fix — the consolidation lock that stops concurrent
 * `decisions --consolidate` processes from clobbering pending.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, utimes, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDecisionsLock, isDecisionsLockHeld } from './lock.js';
import { decisionsDir } from './store.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let root: string;

beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'ol-lock-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('acquireDecisionsLock', () => {
  it('serializes: a second acquire waits until the first releases', async () => {
    const release1 = await acquireDecisionsLock(root);
    let acquired2 = false;
    const p2 = acquireDecisionsLock(root).then((r) => { acquired2 = true; return r; });

    await sleep(450); // > poll interval (150ms): the second acquire must still be blocked
    expect(acquired2).toBe(false);

    await release1();
    const release2 = await p2;
    expect(acquired2).toBe(true);
    await release2();
  });

  it('release is idempotent (double release does not throw)', async () => {
    const release = await acquireDecisionsLock(root);
    await release();
    await expect(release()).resolves.toBeUndefined();
  });

  it('releasing frees the lock so the next acquire is immediate', async () => {
    const r1 = await acquireDecisionsLock(root);
    await r1();
    const t0 = Date.now();
    const r2 = await acquireDecisionsLock(root);
    expect(Date.now() - t0).toBeLessThan(300); // no waiting — lock was free
    await r2();
  });

  it('steals a stale lock left by a crashed holder', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, '.consolidate.lock');
    await writeFile(lockPath, '99999 crashed');
    const old = (Date.now() - 200_000) / 1000; // 200s ago > STALE_MS (120s)
    await utimes(lockPath, old, old);

    // Should steal the stale lock and return promptly, not hang.
    const release = await acquireDecisionsLock(root);
    await stat(lockPath); // lock exists again (ours)
    await release();
  }, 10_000);
});

describe('isDecisionsLockHeld', () => {
  it('false when no lock file exists', async () => {
    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('true while the lock is genuinely held', async () => {
    const release = await acquireDecisionsLock(root);
    expect(await isDecisionsLockHeld(root)).toBe(true);
    await release();
    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('false for a stale lock left by a crashed holder (never blocks a fresh run)', async () => {
    const dir = decisionsDir(root);
    await mkdir(dir, { recursive: true });
    const lockPath = join(dir, '.consolidate.lock');
    await writeFile(lockPath, '99999 crashed');
    const old = (Date.now() - 200_000) / 1000; // 200s ago > STALE_MS (120s)
    await utimes(lockPath, old, old);

    expect(await isDecisionsLockHeld(root)).toBe(false);
  });

  it('never acquires or steals — a pure read leaves the lock untouched', async () => {
    const release = await acquireDecisionsLock(root);
    await isDecisionsLockHeld(root);
    await isDecisionsLockHeld(root);
    // The holder's lock survives the peeks: a second acquire still blocks.
    let acquired2 = false;
    const p2 = acquireDecisionsLock(root).then((r) => { acquired2 = true; return r; });
    await sleep(300);
    expect(acquired2).toBe(false);
    await release();
    // Drain the now-unblocked second acquire and release it. Leaving it pending
    // lets its next poll race afterEach's rm(root): open() then rejects with
    // ENOENT as an unhandled rejection that fails the whole run.
    const release2 = await p2;
    await release2();
  });
});

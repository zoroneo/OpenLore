/**
 * Tests for the atomic watcher singleton (claimWatcherSingleton).
 *
 * Two guarantees: concurrent launches yield exactly one winner (atomic create-exclusive claim),
 * and a claim whose PID was recycled — or is dead/garbage — does not suppress a new watcher forever
 * (heartbeat-staleness steal). See the WatcherSingletonIsAtomic requirement.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { claimWatcherSingleton } from './gryph-watch.js';
import { WATCHER_STALE_MS } from '../../core/services/mcp-handlers/panic-constants.js';

describe('claimWatcherSingleton', () => {
  let dir: string;
  let pidPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-watcher-'));
    mkdirSync(join(dir, '.openlore'), { recursive: true });
    pidPath = join(dir, '.openlore', 'gryph-watch.pid');
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('claims a free slot and records this process as a JSON claim', () => {
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
    expect(existsSync(pidPath)).toBe(true);
    const claim = JSON.parse(readFileSync(pidPath, 'utf-8')) as { pid: number; startedAt: string };
    expect(claim.pid).toBe(process.pid);
    expect(typeof claim.startedAt).toBe('string');
  });

  it('two sequential launches → exactly one wins, the other stands down', () => {
    // The first writes a live, fresh claim; the second observes it and yields.
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
    expect(claimWatcherSingleton(pidPath)).toBe('held');
  });

  it('steals a claim whose PID is dead', () => {
    const deadPid = 2147483646; // no such process → kill(pid,0) throws → treated as dead
    writeFileSync(pidPath, JSON.stringify({ pid: deadPid, startedAt: new Date().toISOString() }));
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
    expect((JSON.parse(readFileSync(pidPath, 'utf-8')) as { pid: number }).pid).toBe(process.pid);
  });

  it('steals a stale-heartbeat claim even when the recorded PID is alive (recycled PID)', () => {
    // A live PID (ours) but a heartbeat older than the stale window → possibly recycled → stealable.
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const staleTime = new Date(Date.now() - WATCHER_STALE_MS - 10_000);
    utimesSync(pidPath, staleTime, staleTime);
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
  });

  it('does NOT steal a live, fresh claim (recycled-PID guard is not over-eager)', () => {
    writeFileSync(pidPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    // fresh mtime (just written) + alive pid → held
    expect(claimWatcherSingleton(pidPath)).toBe('held');
  });

  it('steals a garbage/unparseable claim with a fresh mtime', () => {
    writeFileSync(pidPath, 'not-json-not-a-pid');
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
  });

  it('accepts a legacy bare-integer PID file (dead pid → steal)', () => {
    writeFileSync(pidPath, '2147483646');
    expect(claimWatcherSingleton(pidPath)).toBe('claimed');
  });

  it('returns held when the parent directory does not exist (does not run in a bad dir)', () => {
    expect(claimWatcherSingleton(join(dir, 'nope', 'gryph-watch.pid'))).toBe('held');
  });
});

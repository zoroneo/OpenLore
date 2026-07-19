/**
 * openlore gryph-watch
 *
 * Standalone Gryph behavioral observer. Runs as an independent background
 * process — lifetime decoupled from the MCP server session. Polls Gryph every
 * interval and writes behavioral signals to panic-state.json via CAS writes.
 *
 * Why a separate process: MCP-path Gryph polling only starts after the first
 * openlore tool call. Agents working exclusively via Bash/Edit/Read never
 * trigger that path. gryph-watch closes this gap by running continuously from
 * session start.
 *
 * Signals provided (standalone, without MCP tracker context):
 *   repetitiveRetryBurst — low entropy + failing commands (no stale context needed)
 *
 * Signals requiring MCP tracker (not available here):
 *   largePatchWhileStale — staleDepth unknown without EpistemicLease session
 *
 * Install via: openlore setup --hooks claude
 * Which installs a UserPromptSubmit hook: openlore gryph-watch &
 */

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, statSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { OPENLORE_DIR } from '../../constants.js';
import { readOpenLoreConfig } from '../../core/services/config-manager.js';
import { startGryphPolling } from '../../core/services/mcp-handlers/gryph-bridge.js';
import { WATCHER_HEARTBEAT_MS, WATCHER_STALE_MS } from '../../core/services/mcp-handlers/panic-constants.js';

const PID_FILE = 'gryph-watch.pid';

function findProjectDirectory(startDir: string): string | null {
  let dir = startDir;
  for (;;) {
    if (existsSync(join(dir, OPENLORE_DIR, 'config.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

interface WatcherClaim { pid: number; startedAt: string }

/**
 * Atomically claim the one-watcher-per-directory singleton.
 *
 * Uses `openSync(path, 'wx')` (atomic create-exclusive) so two concurrently launched watchers can
 * never both pass the check — exactly one wins the create, the other observes the winner's live,
 * fresh claim and stands down. This replaces the old `existsSync` + `writeFileSync` TOCTOU.
 *
 * Liveness is not inferred from `kill(pid, 0)` alone: a recycled PID (the old watcher's number now
 * belongs to an unrelated process) would otherwise suppress a legitimate watcher forever. The claim
 * carries a heartbeat — the PID-file mtime, refreshed every WATCHER_HEARTBEAT_MS by the live
 * watcher — and a claim whose heartbeat is older than WATCHER_STALE_MS is stolen even if its PID
 * still answers signal-0. A garbage/legacy-format or dead-PID claim is likewise stolen.
 *
 * Returns 'claimed' if this process now owns the singleton, 'held' if a live watcher already does.
 */
export function claimWatcherSingleton(pidPath: string, now: number = Date.now()): 'claimed' | 'held' {
  // Two attempts: one to steal a stale claim, one to re-create it. A lost steal race (another
  // concurrent starter recreated the file first) resolves to 'held' — that starter runs.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(pidPath, 'wx'); // atomic create-exclusive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return 'held'; // e.g. missing dir → don't run
      if (isClaimStale(pidPath, now)) {
        try { unlinkSync(pidPath); } catch { /* raced — another starter took it */ }
        continue;
      }
      return 'held'; // a live, fresh claim exists
    }
    const claim: WatcherClaim = { pid: process.pid, startedAt: new Date(now).toISOString() };
    try { writeFileSync(fd, JSON.stringify(claim), 'utf-8'); } catch { /* non-fatal */ }
    try { closeSync(fd); } catch { /* ignore */ }
    return 'claimed';
  }
  return 'held';
}

/** A claim is stale (stealable) if its file is unreadable/garbage, its PID is dead, or its
 *  heartbeat (file mtime) is older than WATCHER_STALE_MS (a possibly-recycled PID). */
function isClaimStale(pidPath: string, now: number): boolean {
  try {
    const heartbeatAge = now - statSync(pidPath).mtimeMs;
    if (heartbeatAge > WATCHER_STALE_MS) return true; // heartbeat gone quiet — assume orphaned/recycled
    const raw = readFileSync(pidPath, 'utf-8').trim();
    // Accept both the JSON claim and a legacy bare-integer PID file.
    let pid: number;
    try { pid = (JSON.parse(raw) as WatcherClaim).pid; }
    catch { pid = parseInt(raw, 10); }
    if (!Number.isInteger(pid) || pid <= 0) return true;
    return !isProcessAlive(pid);
  } catch {
    return true; // unreadable → treat as stale
  }
}

export const gryphWatchCommand = new Command('gryph-watch')
  .description('Background Gryph behavioral observer (install via: openlore setup --hooks)')
  .argument('[directory]', 'Project directory — auto-detected from cwd if omitted')
  .action(async (directoryArg?: string) => {
    const directory = directoryArg
      ?? findProjectDirectory(process.cwd())
      ?? process.cwd();

    const cfg = await readOpenLoreConfig(directory);
    const mode = cfg?.panicResponse?.mode ?? 'off';
    if (mode === 'off') process.exit(0);

    // Singleton enforcement: one watcher per directory, via an atomic create-exclusive PID claim
    // that survives PID recycling (heartbeat staleness). See claimWatcherSingleton.
    const pidPath = join(directory, OPENLORE_DIR, PID_FILE);
    if (claimWatcherSingleton(pidPath) === 'held') process.exit(0);

    let cleanedUp = false;
    const cleanup = (): void => {
      if (cleanedUp) return; // idempotent — repeated signals must not double-act
      cleanedUp = true;
      try { unlinkSync(pidPath); } catch { /* ignore */ }
      process.exit(0);
    };
    process.on('SIGTERM', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGHUP', cleanup);

    // Heartbeat: refresh the PID-file mtime so this live watcher's claim stays fresh and is never
    // mistaken for a recycled/orphaned PID by a concurrent starter (see isClaimStale).
    const heartbeat = setInterval((): void => {
      try { const t = new Date(); utimesSync(pidPath, t, t); } catch { /* file gone — cleanup path handles it */ }
    }, WATCHER_HEARTBEAT_MS);
    heartbeat.unref(); // the poll loop's timers keep the process alive; don't double-hold it

    // Lifecycle: this is a backgrounded daemon (`gryph-watch &`), so stdin EOF is NOT a reliable
    // parent-death signal (the launching hook shell closes the pipe immediately) — using it caused
    // the observer to exit one poll in. Instead it runs until an explicit signal, OR until panic is
    // turned off in config (a natural stop control that also bounds an orphaned daemon's lifetime).
    const modeCheck = setInterval((): void => {
      void readOpenLoreConfig(directory).then((c) => {
        if ((c?.panicResponse?.mode ?? 'off') === 'off') cleanup();
      }).catch(() => { /* transient read error — keep running */ });
    }, 30_000);
    modeCheck.unref(); // the poll loop's timers keep the process alive; don't double-hold it

    // startGryphPolling drives a while loop internally — pending setTimeout keeps the process alive.
    // getTracker: () => null is intentional: staleDepth is unknown without an active MCP session.
    // Guard startup so a throw (e.g. bad env) cleans the PID file instead of leaving it stale.
    try {
      startGryphPolling({ directory, getTracker: () => null });
    } catch {
      cleanup();
    }
  });

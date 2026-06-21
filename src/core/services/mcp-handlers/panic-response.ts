/**
 * Panic Response Layer — behavioral destabilization detection.
 *
 * Separate from EpistemicLease (freshness = epistemic authority decay).
 * Panic = observable behavioral instability: oscillation, trajectory bursts,
 * repeated stale-depth-3 persistence.
 *
 * State file: .openlore/panic-state.json (atomic writes, fail-open reads).
 * Hook consumer: `openlore panic-check` reads this file before every agent tool call.
 */

import { writeFileSync, renameSync, readFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { OPENLORE_DIR } from '../../../constants.js';
import {
  PANIC_UP_THRESHOLD,
  PANIC_DOWN_THRESHOLD,
  HOOK_COOLDOWN_MS,
  SEVERITY_MAP,
  PANIC_SESSION_EXPIRY_MS,
} from './panic-constants.js';

// ============================================================================
// TYPES
// ============================================================================

export type PanicLevel = 0 | 1 | 2 | 3 | 4;

export interface PanicState {
  schemaVersion: 1;
  panicScore: number;
  panicLevel: PanicLevel;
  updatedAt: string;
  lastOrientAt: string;
  lastHookInterventionAt?: string;
  recentOrientCount: number;
  localityConfidence: number;
  interventionCountSinceStable: number;
  triggers: string[];
  /** ISO — upward signals suppressed until this timestamp after an orient() recovery. */
  panicRecoverySuppressionUntil?: string;
  /** ISO — start of the Gryph query window for the panic-check hook path. Advanced on each intervention write. */
  gryphWindowStart?: string;
  agentId?: string;
  sessionId?: string;
  /** Monotonically increasing write counter. Used for CAS by concurrent writers (Gryph poll vs MCP). */
  revision: number;
}

export interface PanicCheckOutput {
  decision: 'allow' | 'warn';
  severity?: 'elevated' | 'panic' | 'scope' | 'critical';
  message?: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PANIC_STATE_FILE = 'panic-state.json';

// ============================================================================
// HYSTERESIS
// ============================================================================

export function applyPanicHysteresis(current: PanicLevel, score: number, staleDepth: number): PanicLevel {
  let level = current;

  // Attempt upward transition
  if (level < 4) {
    if (level === 3) {
      // L3→L4 requires both score threshold AND staleDepth ≥ 3
      if (score >= PANIC_UP_THRESHOLD[3] && staleDepth >= 3) level = 4;
    } else {
      if (score >= PANIC_UP_THRESHOLD[level]) level = (level + 1) as PanicLevel;
    }
  }

  // Attempt downward transition (only if we did not just go up)
  if (level === current && level > 0) {
    if (score < PANIC_DOWN_THRESHOLD[level]) level = (level - 1) as PanicLevel;
  }

  // Panic ceiling: stale depth floors minimum level
  const minLevel: PanicLevel = staleDepth >= 3 ? 2 : staleDepth >= 2 ? 1 : 0;
  return Math.max(level, minLevel) as PanicLevel;
}

// ============================================================================
// STATE I/O
// ============================================================================

export function defaultPanicState(): PanicState {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    panicScore: 0,
    panicLevel: 0,
    updatedAt: now,
    lastOrientAt: now,
    recentOrientCount: 0,
    localityConfidence: 0,
    interventionCountSinceStable: 0,
    triggers: [],
    revision: 0,
  };
}

/**
 * Reads panic state. Fails open on all error paths:
 * missing file, parse error, wrong schema version, expired session.
 */
export function readPanicState(directory: string): PanicState {
  try {
    const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
    if (!existsSync(path)) return defaultPanicState();

    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PanicState>;

    if (parsed.schemaVersion !== 1) return defaultPanicState();

    // Session hard reset: zombie state from a previous session must not leak
    if (parsed.updatedAt) {
      const age = Date.now() - new Date(parsed.updatedAt).getTime();
      if (age > PANIC_SESSION_EXPIRY_MS) return defaultPanicState();
    }

    return { ...defaultPanicState(), ...parsed, schemaVersion: 1, revision: parsed.revision ?? 0 };
  } catch {
    return defaultPanicState();
  }
}

// Per-process unique temp suffix — two processes must NOT write to the same `.tmp` path
// (that races into a torn temp that one of them then renames into place).
let _tmpSeq = 0;
function uniqueTmp(path: string): string {
  return `${path}.${process.pid}.${_tmpSeq++}.tmp`;
}

/** Atomically replace `path` with `state@revision` via a unique temp + rename. On ANY failure the
 *  temp is unlinked (so a persistent error — disk full, dir-typed target — can't leak temp files)
 *  and false is returned. Never throws. */
function atomicWriteState(path: string, state: PanicState, revision: number): boolean {
  const tmp = uniqueTmp(path);
  try {
    writeFileSync(tmp, JSON.stringify({ ...state, revision }, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    try { unlinkSync(tmp); } catch { /* temp may not exist */ }
    return false;
  }
}

/**
 * Atomically writes panic state. POSIX rename(2) is atomic on same filesystem.
 * Bumps revision on every write — callers sync their own revision counter from the return value.
 * Never throws — must not crash the hot path.
 * Returns the new revision written (or the existing revision if write failed).
 */
export function writePanicState(directory: string, state: PanicState): number {
  const newRevision = (state.revision ?? 0) + 1;
  const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
  return atomicWriteState(path, state, newRevision) ? newRevision : (state.revision ?? 0);
}

// ── Cross-process lock for read-modify-write on panic-state.json ──────────────
// O_CREAT|O_EXCL gives an atomic acquire across separate OS processes (the panic
// subsystem has up to three writers: MCP server, the panic-check hook, gryph-watch).
// A held lock older than LOCK_STALE_MS is assumed orphaned (holder crashed) and stolen.
// LOCK_STALE_MS is kept low because every legitimate critical section is sub-millisecond, so a
// crashed holder is recovered quickly and the lost-update window during a crash stays small.
const LOCK_STALE_MS = 1_500;
const LOCK_MAX_ATTEMPTS = 80;
// The background daemon (gryph poll) uses a SHORT budget so a contended lock doesn't stall its
// event loop — it simply skips this write and retries on the next poll interval.
export const LOCK_ATTEMPTS_DAEMON = 12;

function sleepSyncMs(ms: number): void {
  // Block the thread without busy-spinning (these are short-lived CLI/daemon processes).
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(1, ms)); } catch { /* ignore */ }
}

/**
 * Run `fn` while holding an exclusive cross-process lock on the panic-state file.
 * Returns fn()'s result, or `fallback` if the lock cannot be acquired OR `fn` throws (fail-open —
 * the panic subsystem must never block or crash a tool call over a contended/failed write).
 */
function withPanicStateLock<T>(directory: string, fn: () => T, fallback: T, maxAttempts = LOCK_MAX_ATTEMPTS): T {
  const lockPath = `${join(directory, OPENLORE_DIR, PANIC_STATE_FILE)}.lock`;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let fd: number;
    try {
      fd = openSync(lockPath, 'wx'); // atomic create-exclusive
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') return fallback; // e.g. missing dir → fail open
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) { try { unlinkSync(lockPath); } catch { /* raced */ } }
      } catch { /* lock vanished between open and stat — retry immediately */ }
      sleepSyncMs(3 + (attempt & 7));
      continue;
    }
    try {
      return fn();
    } catch {
      return fallback; // fn must never throw out of the lock — fail open
    } finally {
      try { closeSync(fd); } catch { /* ignore */ }
      try { unlinkSync(lockPath); } catch { /* ignore */ }
    }
  }
  return fallback; // contended past the attempt budget → fail open
}

/**
 * Compare-and-swap write across concurrent writers (Gryph poll vs MCP vs hook).
 * Serialized by an exclusive cross-process lock so the read-check-write is atomic against OTHER
 * PROCESSES (not just within one event loop). Returns false if on-disk revision !== expectedRevision
 * (stale read → caller retries), the lock could not be acquired, or the write failed.
 * `maxAttempts` lets the background daemon use a short budget (LOCK_ATTEMPTS_DAEMON).
 */
export function casWritePanicState(
  directory: string,
  expectedRevision: number,
  state: PanicState,
  maxAttempts: number = LOCK_MAX_ATTEMPTS,
): boolean {
  return withPanicStateLock(directory, () => {
    const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
    let currentRevision = 0;
    if (existsSync(path)) {
      try { currentRevision = (JSON.parse(readFileSync(path, 'utf-8')) as Partial<PanicState>).revision ?? 0; }
      catch { currentRevision = 0; }
    }
    if (currentRevision !== expectedRevision) return false;
    return atomicWriteState(path, state, expectedRevision + 1);
  }, false, maxAttempts);
}

/**
 * Atomically (cross-process) record a hook intervention: re-read the freshest state under the lock,
 * bump interventionCountSinceStable, merge the given fields, and persist. Returns the new count.
 * This prevents concurrent panic-check processes from losing increments (last-writer-wins on a
 * non-locked read-modify-write under-counts the advisory→directive escalation gate).
 */
export function recordHookInterventionLocked(
  directory: string,
  fields: { lastHookInterventionAt: string; gryphWindowStart?: string },
  fallbackCount: number,
): number {
  return withPanicStateLock(
    directory,
    () => {
      const fresh = readPanicState(directory);
      const newCount = fresh.interventionCountSinceStable + 1;
      writePanicState(directory, { ...fresh, ...fields, interventionCountSinceStable: newCount });
      return newCount;
    },
    fallbackCount,
  );
}

// ============================================================================
// PANIC CHECK OUTPUT (hook response builder)
// ============================================================================

const ADVISORY_MESSAGES: Record<PanicLevel, string> = {
  0: '',
  1: '[PANIC:ELEVATED] Recent navigation suggests increasing architectural uncertainty.\nConsider: summarize current assumptions, identify uncertain dependencies, call orient().',
  2: '[PANIC:PLANNING] Before cross-module modification, state:\n1. Intended architectural impact  2. Modules affected  3. Rollback strategy\nThen proceed.',
  3: '[PANIC:SCOPE] Cross-module writes discouraged until orient().\nPrefer local changes. orient() expands operational scope.',
  4: '[PANIC:CRITICAL] Critical epistemic instability. Call orient() before further modifications.',
};

const DIRECTIVE_MESSAGES: Record<PanicLevel, string> = {
  0: '',
  1: '[PANIC:ELEVATED:DIRECTIVE] Previous checkpoint ignored. Stop and call orient() now.',
  2: '[PANIC:PLANNING:DIRECTIVE] Previous checkpoint ignored. Stop. Run orient() now before proceeding.',
  3: '[PANIC:SCOPE:DIRECTIVE] Scope reduction warning ignored. Stop all cross-module writes. Call orient() immediately.',
  4: '[PANIC:CRITICAL] Critical epistemic instability. Call orient() before further modifications.',
};

/**
 * Builds the structured output for the panic-check CLI hook consumer.
 * Always exits 0 — severity encoded in payload, not exit code.
 * Applies per-level cooldown: no-ops if intervention fired recently.
 */
export function buildPanicCheckOutput(state: PanicState): PanicCheckOutput {
  if (state.panicLevel === 0) return { decision: 'allow' };

  // Apply cooldown (L4 is exempt — always fires)
  if (state.panicLevel < 4 && state.lastHookInterventionAt) {
    const elapsed = Date.now() - new Date(state.lastHookInterventionAt).getTime();
    if (elapsed < HOOK_COOLDOWN_MS[state.panicLevel]) return { decision: 'allow' };
  }

  const isDirective = state.interventionCountSinceStable >= 3;
  const messages = isDirective ? DIRECTIVE_MESSAGES : ADVISORY_MESSAGES;
  const message = messages[state.panicLevel];

  return {
    decision: 'warn',
    severity: SEVERITY_MAP[state.panicLevel],
    message,
  };
}

/** Advisory MCP response injection begins at L2 — the documented advisory-injection floor and the
 *  same threshold the accuracy gate/calibration measure (L1 is "elevated": tracked, not intervened on).
 *  Keeping L1 silent avoids nagging on a weak signal and matches `advisory (surface a signal at L2+)`. */
export const PANIC_INJECTION_MIN_LEVEL = 2;

/**
 * Returns panic signal text for MCP tool response injection, or null below the injection floor.
 * Appended after result (not prepended) to preserve JSON structure.
 */
export function getPanicSignalText(state: PanicState): string | null {
  if (state.panicLevel < PANIC_INJECTION_MIN_LEVEL) return null;
  const isDirective = state.interventionCountSinceStable >= 3;
  const messages = isDirective ? DIRECTIVE_MESSAGES : ADVISORY_MESSAGES;
  return messages[state.panicLevel] ?? null;
}

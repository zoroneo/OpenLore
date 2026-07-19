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
  PANIC_SCORE_MAX,
  PANIC_DECAY_PER_MIN,
  PANIC_RECOVERY_TOOLS,
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

/**
 * Apply passive wall-clock decay to a persisted panic state and re-settle its level.
 *
 * The standalone panic-check hook path never recomputes the score (only the MCP tracker and the
 * gryph poll do). So an agent working exclusively via Bash/Edit — the exact case the hook exists to
 * cover — would sit at a level 4 block forever, with nothing to lower it. This applies the SAME
 * passive decay the tracker uses (`PANIC_DECAY_PER_MIN` per elapsed minute since `updatedAt`) and
 * steps the level down through the existing hysteresis thresholds until it settles. No new tuning
 * constant: the deescalation window is fully determined by the decay rate and the down-thresholds
 * (from L4 at score 100 that is (100 − PANIC_DOWN_THRESHOLD[4]) / PANIC_DECAY_PER_MIN = 4 min to
 * leave L4, and on down). staleDepth is unknown in the hook path, so 0 is used — the persisted
 * level already encodes any earlier stale floor, and decay is only allowed to LOWER it (a returned
 * level never exceeds the input level).
 */
export function deescalatePanicByWallClock(state: PanicState, now: number = Date.now()): PanicState {
  const updatedMs = new Date(state.updatedAt).getTime();
  if (!Number.isFinite(updatedMs)) return state;
  const elapsedMin = Math.max(0, (now - updatedMs) / 60_000);
  const decay = Math.floor(elapsedMin * PANIC_DECAY_PER_MIN);
  if (decay <= 0) return state;

  const newScore = Math.max(0, state.panicScore - decay);
  // Settle the level for the decayed score by applying the existing single-step hysteresis to a
  // fixpoint (staleDepth 0). Bounded to ≤5 iterations — one per possible level.
  let level = state.panicLevel;
  for (let i = 0; i < 5; i++) {
    const next = applyPanicHysteresis(level, newScore, 0);
    if (next === level) break;
    level = next;
  }
  // Decay must never raise the level (defensive: applyPanicHysteresis only steps down here).
  const settled = Math.min(level, state.panicLevel) as PanicLevel;
  return { ...state, panicScore: newScore, panicLevel: settled };
}

/**
 * Parse the pending tool name from a PreToolUse hook payload (Claude Code / codex schema).
 * Returns null if the payload is empty, not JSON, or carries no recognizable tool-name field —
 * the caller must treat null as "unknown", never as "not a recovery tool".
 */
export function parsePendingToolName(rawPayload: string): string | null {
  const raw = rawPayload.trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const name = obj['tool_name'] ?? obj['toolName'] ?? obj['tool'];
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * True if `toolName` is one of the read-only recovery tools an L4 block must let through.
 * Normalizes an MCP-namespaced name (`mcp__openlore__orient`, `server__orient`) to its base name.
 */
export function isRecoveryTool(toolName: string | null | undefined): boolean {
  if (!toolName) return false;
  const segments = toolName.split('__');
  const base = segments[segments.length - 1].toLowerCase();
  return PANIC_RECOVERY_TOOLS.includes(base);
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

/** Clamp an untrusted JSON value to a finite number in [min, max], or fall back. */
function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
}

/**
 * Reads panic state. Fails open on all error paths:
 * missing file, parse error, wrong schema version, expired/invalid session.
 *
 * panic-state.json is a hand-editable on-disk file, so every field is treated as
 * untrusted: numeric fields are coerced and clamped so a garbage value (NaN, a
 * string, an out-of-range level) can't poison scoring or index off the end of
 * SEVERITY_MAP/DIRECTIVE_MESSAGES, and a non-parseable `updatedAt` (NaN age) is
 * treated as expired rather than letting a zombie state survive forever.
 */
export function readPanicState(directory: string): PanicState {
  try {
    const path = join(directory, OPENLORE_DIR, PANIC_STATE_FILE);
    if (!existsSync(path)) return defaultPanicState();

    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<PanicState>;

    if (parsed.schemaVersion !== 1) return defaultPanicState();

    // Session hard reset: zombie state from a previous session must not leak. A
    // missing OR unparseable updatedAt (age === NaN) is treated as expired.
    const age = Date.now() - new Date(parsed.updatedAt ?? 0).getTime();
    if (!Number.isFinite(age) || age > PANIC_SESSION_EXPIRY_MS) return defaultPanicState();

    const base = defaultPanicState();
    return {
      ...base,
      ...parsed,
      schemaVersion: 1,
      panicScore: clampNum(parsed.panicScore, 0, PANIC_SCORE_MAX, base.panicScore),
      panicLevel: clampNum(Math.trunc(Number(parsed.panicLevel)), 0, 4, base.panicLevel) as PanicLevel,
      recentOrientCount: clampNum(Math.trunc(Number(parsed.recentOrientCount)), 0, Number.MAX_SAFE_INTEGER, base.recentOrientCount),
      localityConfidence: clampNum(parsed.localityConfidence, 0, 1, base.localityConfidence),
      interventionCountSinceStable: clampNum(Math.trunc(Number(parsed.interventionCountSinceStable)), 0, Number.MAX_SAFE_INTEGER, base.interventionCountSinceStable),
      triggers: Array.isArray(parsed.triggers) ? parsed.triggers.filter((t): t is string => typeof t === 'string') : base.triggers,
      revision: clampNum(Math.trunc(Number(parsed.revision)), 0, Number.MAX_SAFE_INTEGER, 0),
    };
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

/**
 * Locked read-modify-write for panic-state.json: under the cross-process lock, read the
 * FRESHEST on-disk state, apply `mutate(fresh)`, persist with a bumped revision, and return
 * the written state. This is the serialization primitive the MCP writer uses so it cannot
 * clobber a concurrent panic-check hook (`recordHookInterventionLocked`) or gryph daemon
 * (`casWritePanicState`) write — in particular the cross-process `interventionCountSinceStable`
 * counter stays monotonic (the MCP path previously read-then-wrote via an unlocked
 * `writePanicState`, racing the hook's locked increment).
 *
 * Because the read and write happen under the same lock, no separate CAS retry is needed —
 * the lock guarantees no other writer interleaves. Fails open: if the lock cannot be acquired
 * the mutation is applied to a fresh read and written best-effort (unlocked), degrading to the
 * prior behavior rather than blocking the hot path. Never throws.
 */
export function mutatePanicStateLocked(
  directory: string,
  mutate: (fresh: PanicState) => PanicState,
): PanicState {
  const apply = (): PanicState => {
    const fresh = readPanicState(directory);
    // Seed revision from the freshest disk read so writePanicState bumps to fresh+1
    // (monotonic across all writers; under the lock there is no concurrent writer).
    const next: PanicState = { ...mutate(fresh), revision: fresh.revision };
    const revision = writePanicState(directory, next);
    return { ...next, revision };
  };
  return withPanicStateLock<PanicState | null>(directory, apply, null) ?? apply();
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

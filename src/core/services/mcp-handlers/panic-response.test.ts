/**
 * Tests for panic-response.ts
 *   - applyPanicHysteresis
 *   - readPanicState / writePanicState
 *   - buildPanicCheckOutput
 *   - getPanicSignalText
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  applyPanicHysteresis,
  defaultPanicState,
  readPanicState,
  writePanicState,
  casWritePanicState,
  recordHookInterventionLocked,
  mutatePanicStateLocked,
  buildPanicCheckOutput,
  getPanicSignalText,
  deescalatePanicByWallClock,
  parsePendingToolName,
  isRecoveryTool,
} from './panic-response.js';
import type { PanicState, PanicLevel } from './panic-response.js';
import {
  PANIC_UP_THRESHOLD,
  PANIC_DOWN_THRESHOLD,
  HOOK_COOLDOWN_MS,
  PANIC_SESSION_EXPIRY_MS,
  PANIC_DECAY_PER_MIN,
} from './panic-constants.js';
import { OPENLORE_DIR } from '../../../constants.js';

// ============================================================================
// applyPanicHysteresis
// ============================================================================

describe('applyPanicHysteresis', () => {
  it('stays 0 below up-threshold', () => {
    expect(applyPanicHysteresis(0, PANIC_UP_THRESHOLD[0] - 1, 0)).toBe(0);
  });

  it('transitions 0→1 at up-threshold', () => {
    expect(applyPanicHysteresis(0, PANIC_UP_THRESHOLD[0], 0)).toBe(1);
  });

  it('transitions 1→2 at up-threshold', () => {
    expect(applyPanicHysteresis(1, PANIC_UP_THRESHOLD[1], 0)).toBe(2);
  });

  it('transitions 2→3 at up-threshold', () => {
    expect(applyPanicHysteresis(2, PANIC_UP_THRESHOLD[2], 0)).toBe(3);
  });

  it('L3→L4 requires staleDepth ≥ 3', () => {
    expect(applyPanicHysteresis(3, PANIC_UP_THRESHOLD[3], 2)).toBe(3);
    expect(applyPanicHysteresis(3, PANIC_UP_THRESHOLD[3], 3)).toBe(4);
  });

  it('does not downgrade when score above down-threshold', () => {
    expect(applyPanicHysteresis(2, PANIC_DOWN_THRESHOLD[2] + 1, 0)).toBe(2);
  });

  it('downgrade 2→1 when score below down-threshold', () => {
    expect(applyPanicHysteresis(2, PANIC_DOWN_THRESHOLD[2] - 1, 0)).toBe(1);
  });

  it('downgrade 3→2 when score below down-threshold', () => {
    expect(applyPanicHysteresis(3, PANIC_DOWN_THRESHOLD[3] - 1, 0)).toBe(2);
  });

  it('no simultaneous up and down transition', () => {
    expect(applyPanicHysteresis(0, PANIC_UP_THRESHOLD[0], 0)).toBe(1);
  });

  it('panic ceiling: staleDepth ≥ 3 floors minimum at L2', () => {
    // even score 0 → at least L2 when staleDepth=3
    expect(applyPanicHysteresis(0, 0, 3)).toBe(2);
  });

  it('panic ceiling: staleDepth ≥ 2 floors minimum at L1', () => {
    expect(applyPanicHysteresis(0, 0, 2)).toBe(1);
  });

  it('panic ceiling: staleDepth 0 no floor', () => {
    expect(applyPanicHysteresis(0, 0, 0)).toBe(0);
  });

  it('L4 stays at L4 — no upward beyond max', () => {
    expect(applyPanicHysteresis(4, 100, 3)).toBe(4);
  });
});

// ============================================================================
// readPanicState / writePanicState
// ============================================================================

describe('readPanicState', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'openlore-panic-test-'));
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
  });

  it('returns defaultPanicState when file missing (fail-open)', () => {
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
    expect(state.panicScore).toBe(0);
    expect(state.schemaVersion).toBe(1);
  });

  it('returns defaultPanicState on parse error (fail-open)', async () => {
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), 'not-json', 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('returns defaultPanicState on wrong schema version (fail-open)', async () => {
    const bad = JSON.stringify({ schemaVersion: 99, panicScore: 80, panicLevel: 3, updatedAt: new Date().toISOString() });
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), bad, 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('returns defaultPanicState when session expired', async () => {
    const old = new Date(Date.now() - PANIC_SESSION_EXPIRY_MS - 60_000).toISOString();
    const expired: PanicState = { ...defaultPanicState(), panicScore: 80, panicLevel: 3, updatedAt: old, lastOrientAt: old };
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), JSON.stringify(expired), 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
  });

  it('round-trips state within session', () => {
    const initial: PanicState = {
      ...defaultPanicState(),
      panicScore: 55,
      panicLevel: 2,
      triggers: ['oscillation'],
    };
    writePanicState(dir, initial);
    const read = readPanicState(dir);
    expect(read.panicScore).toBe(55);
    expect(read.panicLevel).toBe(2);
    expect(read.triggers).toEqual(['oscillation']);
  });

  it('treats an unparseable updatedAt as expired (NaN age must not preserve zombie state)', async () => {
    // new Date("oops").getTime() is NaN, so the old `age > EXPIRY` check was false
    // and a corrupt file survived forever. It must now reset to default.
    const bad = JSON.stringify({ schemaVersion: 1, panicScore: 90, panicLevel: 4, updatedAt: 'oops' });
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), bad, 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicLevel).toBe(0);
    expect(state.panicScore).toBe(0);
  });

  it('sanitizes garbage numeric fields rather than passing them into scoring', async () => {
    const now = new Date().toISOString();
    const garbage = JSON.stringify({
      schemaVersion: 1,
      updatedAt: now,
      panicScore: 'abc',          // non-number → default 0
      panicLevel: 99,             // out of range → clamped to 4
      localityConfidence: 5,      // > 1 → clamped to 1
      interventionCountSinceStable: -3, // negative → clamped to 0
      triggers: ['ok', 42, null], // non-strings dropped
    });
    await writeFile(join(dir, OPENLORE_DIR, 'panic-state.json'), garbage, 'utf-8');
    const state = readPanicState(dir);
    expect(state.panicScore).toBe(0);
    expect(state.panicLevel).toBe(4);
    expect(state.localityConfidence).toBe(1);
    expect(state.interventionCountSinceStable).toBe(0);
    expect(state.triggers).toEqual(['ok']);
  });
});

// ============================================================================
// buildPanicCheckOutput
// ============================================================================

describe('buildPanicCheckOutput', () => {
  it('returns allow at level 0', () => {
    const out = buildPanicCheckOutput(defaultPanicState());
    expect(out.decision).toBe('allow');
    expect(out.severity).toBeUndefined();
  });

  it('returns warn at level 1 with no prior intervention', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 1 };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
    expect(out.severity).toBe('elevated');
    expect(out.message).toContain('[PANIC:ELEVATED]');
  });

  it('returns allow when within L1 cooldown', () => {
    const recentIntervention = new Date(Date.now() - HOOK_COOLDOWN_MS[1] / 2).toISOString();
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 1,
      lastHookInterventionAt: recentIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('allow');
  });

  it('returns warn when L1 cooldown expired', () => {
    const oldIntervention = new Date(Date.now() - HOOK_COOLDOWN_MS[1] - 10_000).toISOString();
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 1,
      lastHookInterventionAt: oldIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
  });

  it('L4 always fires regardless of cooldown', () => {
    const recentIntervention = new Date(Date.now() - 1_000).toISOString();
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 4,
      lastHookInterventionAt: recentIntervention,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.decision).toBe('warn');
    expect(out.severity).toBe('critical');
  });

  it('switches to directive message at interventionCountSinceStable ≥ 3', () => {
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 2,
      interventionCountSinceStable: 3,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.message).toContain('[PANIC:PLANNING:DIRECTIVE]');
  });

  it('uses advisory message at interventionCountSinceStable < 3', () => {
    const state: PanicState = {
      ...defaultPanicState(),
      panicLevel: 2,
      interventionCountSinceStable: 2,
    };
    const out = buildPanicCheckOutput(state);
    expect(out.message).toContain('[PANIC:PLANNING]');
    expect(out.message).not.toContain('DIRECTIVE');
  });

  it('severity map: L1→elevated, L2→panic, L3→scope, L4→critical', () => {
    const levels: [PanicLevel, string][] = [[1, 'elevated'], [2, 'panic'], [3, 'scope'], [4, 'critical']];
    for (const [level, expected] of levels) {
      const state: PanicState = { ...defaultPanicState(), panicLevel: level };
      const out = buildPanicCheckOutput(state);
      expect(out.severity).toBe(expected);
    }
  });
});

// ============================================================================
// getPanicSignalText
// ============================================================================

describe('getPanicSignalText', () => {
  it('returns null at level 0', () => {
    expect(getPanicSignalText(defaultPanicState())).toBeNull();
  });

  it('returns null at level 1 (advisory injection floor is L2 — L1 is observe-only)', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 1 };
    expect(getPanicSignalText(state)).toBeNull();
  });

  it('returns advisory text at level 2 (the injection floor)', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 2 };
    const text = getPanicSignalText(state);
    expect(text).not.toBeNull();
    expect(text).toContain('[PANIC:PLANNING]');
  });

  it('returns directive text when interventionCountSinceStable ≥ 3', () => {
    const state: PanicState = { ...defaultPanicState(), panicLevel: 3, interventionCountSinceStable: 3 };
    const text = getPanicSignalText(state);
    expect(text).toContain('DIRECTIVE');
  });
});

// ============================================================================
// Cross-process locked writes (adversarial-round fixes C1/C2)
// ============================================================================

describe('casWritePanicState (locked CAS)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'panic-cas-'));
    await mkdir(join(dir, '.openlore'), { recursive: true });
  });

  const seed = (revision: number) => writePanicState(dir, { ...defaultPanicState(), revision: revision - 1 });

  it('rejects a stale expected revision and accepts a matching one', () => {
    seed(5); // file now at revision 5
    expect(casWritePanicState(dir, 4, defaultPanicState())).toBe(false); // stale
    expect(casWritePanicState(dir, 5, defaultPanicState())).toBe(true);  // matches → writes rev 6
    expect(readPanicState(dir).revision).toBe(6);
  });

  it('leaves no lock or temp files behind', () => {
    seed(1);
    casWritePanicState(dir, 1, defaultPanicState());
    const leftovers = readdirSync(join(dir, '.openlore')).filter((f) => f.endsWith('.lock') || f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

describe('recordHookInterventionLocked', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'panic-hook-'));
    await mkdir(join(dir, '.openlore'), { recursive: true });
  });

  it('increments interventionCountSinceStable atomically and persists the merged fields', () => {
    writePanicState(dir, { ...defaultPanicState(), panicLevel: 3, interventionCountSinceStable: 2 });
    const now = new Date().toISOString();
    const newCount = recordHookInterventionLocked(dir, { lastHookInterventionAt: now, gryphWindowStart: now }, 99);
    expect(newCount).toBe(3); // 2 + 1, NOT the fallback
    const s = readPanicState(dir);
    expect(s.interventionCountSinceStable).toBe(3);
    expect(s.lastHookInterventionAt).toBe(now);
    expect(readdirSync(join(dir, '.openlore')).filter((f) => f.endsWith('.lock'))).toEqual([]);
  });

  it('returns the fallback when the directory is unwritable (fail-open, never throws)', () => {
    // A non-existent .openlore dir means the lock open fails → fallback, no throw.
    const bad = join(dir, 'nope');
    expect(() => recordHookInterventionLocked(bad, { lastHookInterventionAt: 'x' }, 7)).not.toThrow();
    expect(recordHookInterventionLocked(bad, { lastHookInterventionAt: 'x' }, 7)).toBe(7);
  });
});

describe('mutatePanicStateLocked', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'panic-mutate-'));
    await mkdir(join(dir, '.openlore'), { recursive: true });
  });

  it('reads the FRESHEST on-disk state, applies the mutation, and bumps revision', () => {
    const r0 = writePanicState(dir, { ...defaultPanicState(), interventionCountSinceStable: 5 });
    const written = mutatePanicStateLocked(dir, (fresh) => ({
      ...fresh,
      interventionCountSinceStable: fresh.interventionCountSinceStable + 1,
    }));
    // Composed with the on-disk value (5 → 6), not a stale in-memory 0.
    expect(written.interventionCountSinceStable).toBe(6);
    expect(written.revision).toBe(r0 + 1);
    expect(readPanicState(dir).interventionCountSinceStable).toBe(6);
  });

  it('does NOT clobber a concurrent writer\'s counter increment (the lost-update fix)', () => {
    // Simulate the MCP path reading a stale tracker (count 0) while the panic-check hook
    // has already pushed the on-disk counter to 4. The MCP injection must compose with
    // disk (4 → 5), not overwrite it with the stale tracker value.
    writePanicState(dir, { ...defaultPanicState(), panicLevel: 2, interventionCountSinceStable: 4 });
    const staleTrackerCount = 0;
    const written = mutatePanicStateLocked(dir, (fresh) => ({
      ...fresh,
      // a per-call score update that (buggily) carried the stale tracker count would write
      // staleTrackerCount; the fix reads fresh.interventionCountSinceStable instead.
      interventionCountSinceStable: fresh.interventionCountSinceStable + 1,
      panicScore: 50 + staleTrackerCount, // tracker-owned field still applied
    }));
    expect(written.interventionCountSinceStable).toBe(5); // 4 (disk) + 1, NOT 1
  });

  it('fails open to a best-effort write when the lock dir is unwritable (never throws)', () => {
    const bad = join(dir, 'nope'); // no .openlore → lock open fails
    expect(() => mutatePanicStateLocked(bad, (s) => s)).not.toThrow();
  });
});

describe('locked writes fail open on a write failure (adversarial final round)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'panic-failopen-'));
    await mkdir(join(dir, '.openlore'), { recursive: true });
    // Make the state path a DIRECTORY so writeFileSync/renameSync inside the lock fail.
    await mkdir(join(dir, '.openlore', 'panic-state.json'), { recursive: true });
  });

  it('casWritePanicState returns false (never throws) and leaks no temp/lock files', () => {
    let result: boolean | undefined;
    expect(() => { for (let i = 0; i < 10; i++) result = casWritePanicState(dir, 0, defaultPanicState()); }).not.toThrow();
    expect(result).toBe(false);
    const leftovers = readdirSync(join(dir, '.openlore')).filter((f) => f.endsWith('.tmp') || f.endsWith('.lock'));
    expect(leftovers).toEqual([]);
  });

  it('recordHookInterventionLocked never throws and leaks no temp files on write failure', () => {
    // writePanicState fails gracefully (returns, never throws), so the computed count is returned and
    // no exception escapes; the key guarantees are no-throw + no leaked temp files.
    expect(() => recordHookInterventionLocked(dir, { lastHookInterventionAt: 'x' }, 42)).not.toThrow();
    expect(readdirSync(join(dir, '.openlore')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('recordHookInterventionLocked returns the fallback when the lock cannot be acquired (missing dir)', () => {
    const noDir = join(dir, 'does-not-exist');
    expect(recordHookInterventionLocked(noDir, { lastHookInterventionAt: 'x' }, 42)).toBe(42);
  });
});

// ============================================================================
// deescalatePanicByWallClock — the bounded L4 auto-deescalation (no permanent trap)
// ============================================================================

describe('deescalatePanicByWallClock', () => {
  const stateAt = (updatedMsAgo: number, score: number, level: PanicLevel): PanicState => ({
    ...defaultPanicState(),
    updatedAt: new Date(Date.now() - updatedMsAgo).toISOString(),
    panicScore: score,
    panicLevel: level,
  });

  it('does not change a freshly-updated state (no elapsed time → no decay)', () => {
    const s = stateAt(0, 100, 4);
    const out = deescalatePanicByWallClock(s);
    expect(out.panicLevel).toBe(4);
    expect(out.panicScore).toBe(100);
  });

  it('lifts an L4 block once enough wall-clock passes for score to fall below the L4 down-threshold', () => {
    // From score 100, leaving L4 needs (100 - PANIC_DOWN_THRESHOLD[4]) / PANIC_DECAY_PER_MIN minutes.
    const minutesToLeaveL4 = (100 - PANIC_DOWN_THRESHOLD[4]) / PANIC_DECAY_PER_MIN;
    const justBefore = stateAt((minutesToLeaveL4 - 0.5) * 60_000, 100, 4);
    expect(deescalatePanicByWallClock(justBefore).panicLevel).toBe(4); // not yet
    const justAfter = stateAt((minutesToLeaveL4 + 0.5) * 60_000, 100, 4);
    expect(deescalatePanicByWallClock(justAfter).panicLevel).toBeLessThan(4); // block lifts
  });

  it('settles all the way to 0 after a long idle window', () => {
    const out = deescalatePanicByWallClock(stateAt(60 * 60_000, 100, 4)); // 1 hour
    expect(out.panicLevel).toBe(0);
    expect(out.panicScore).toBe(0);
  });

  it('never raises the level (decay only lowers)', () => {
    const out = deescalatePanicByWallClock(stateAt(10 * 60_000, 100, 2));
    expect(out.panicLevel).toBeLessThanOrEqual(2);
  });

  it('applies exactly PANIC_DECAY_PER_MIN per elapsed minute to the score', () => {
    const out = deescalatePanicByWallClock(stateAt(3 * 60_000, 100, 4));
    expect(out.panicScore).toBe(100 - 3 * PANIC_DECAY_PER_MIN);
  });

  it('is inert on an unparseable updatedAt (never throws, no change)', () => {
    const s = { ...defaultPanicState(), updatedAt: 'not-a-date', panicScore: 100, panicLevel: 4 as PanicLevel };
    expect(() => deescalatePanicByWallClock(s)).not.toThrow();
    expect(deescalatePanicByWallClock(s).panicLevel).toBe(4);
  });
});

// ============================================================================
// parsePendingToolName + isRecoveryTool — L4 recovery-call exemption
// ============================================================================

describe('parsePendingToolName', () => {
  it('reads the Claude Code PreToolUse tool_name field', () => {
    expect(parsePendingToolName(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }))).toBe('Bash');
  });
  it('accepts toolName / tool aliases', () => {
    expect(parsePendingToolName(JSON.stringify({ toolName: 'Edit' }))).toBe('Edit');
    expect(parsePendingToolName(JSON.stringify({ tool: 'Read' }))).toBe('Read');
  });
  it('returns null (unknown) for empty, non-JSON, or nameless payloads', () => {
    expect(parsePendingToolName('')).toBeNull();
    expect(parsePendingToolName('   ')).toBeNull();
    expect(parsePendingToolName('{ not json')).toBeNull();
    expect(parsePendingToolName(JSON.stringify({ foo: 'bar' }))).toBeNull();
    expect(parsePendingToolName(JSON.stringify({ tool_name: '' }))).toBeNull();
  });
});

describe('isRecoveryTool', () => {
  it('matches orient in bare and MCP-namespaced forms', () => {
    expect(isRecoveryTool('orient')).toBe(true);
    expect(isRecoveryTool('mcp__openlore__orient')).toBe(true);
    expect(isRecoveryTool('someserver__orient')).toBe(true);
  });
  it('matches the read-only recovery no-ops', () => {
    expect(isRecoveryTool('mcp__openlore__recall')).toBe(true);
    expect(isRecoveryTool('mcp__openlore__blast_radius')).toBe(true);
  });
  it('does not match write/other tools or unknown/null', () => {
    expect(isRecoveryTool('Bash')).toBe(false);
    expect(isRecoveryTool('Edit')).toBe(false);
    expect(isRecoveryTool('mcp__openlore__record_decision')).toBe(false);
    expect(isRecoveryTool(null)).toBe(false);
    expect(isRecoveryTool(undefined)).toBe(false);
  });
});

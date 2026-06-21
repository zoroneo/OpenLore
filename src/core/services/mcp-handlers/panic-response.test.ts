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
  buildPanicCheckOutput,
  getPanicSignalText,
} from './panic-response.js';
import type { PanicState, PanicLevel } from './panic-response.js';
import {
  PANIC_UP_THRESHOLD,
  PANIC_DOWN_THRESHOLD,
  HOOK_COOLDOWN_MS,
  PANIC_SESSION_EXPIRY_MS,
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

/**
 * Tests for the openlore decisions programmatic API — the promotion guard on
 * openloreSyncDecisions.
 *
 * fix-decision-status-transitions: the API's id-scoped sync must refuse to
 * promote a rejected (or already-synced) decision to approved, the same way the
 * MCP handler and the CLI do — one shared transition table, every door locked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks (hoisted) ────────────────────────────────────────────────────

vi.mock('../utils/command-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/command-helpers.js')>();
  return { ...actual, fileExists: vi.fn(async () => true) };
});

vi.mock('../core/services/config-manager.js', () => ({
  readOpenLoreConfig: vi.fn(async () => ({ version: '1.0.0', openspecPath: './openspec' })),
}));

vi.mock('../core/drift/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/drift/index.js')>();
  return { ...actual, buildSpecMap: vi.fn(async () => ({})) };
});

vi.mock('../core/decisions/syncer.js', () => ({
  syncApprovedDecisions: vi.fn(async (store: unknown) => ({
    store,
    result: { synced: [], errors: [], modifiedSpecs: [] },
  })),
}));

// Keep the real store module (real illegalPromotionToApproved) but stub the disk read.
vi.mock('../core/decisions/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/decisions/store.js')>();
  return { ...actual, loadDecisionStore: vi.fn() };
});

// ── Imports ───────────────────────────────────────────────────────────────────

import { openloreSyncDecisions } from './decisions.js';
import { loadDecisionStore } from '../core/decisions/store.js';
import { syncApprovedDecisions } from '../core/decisions/syncer.js';
import type { DecisionStore, PendingDecision } from '../types/index.js';

function makeDecision(overrides: Partial<PendingDecision> = {}): PendingDecision {
  return {
    id: 'abc12345',
    status: 'draft',
    title: 'Use SQLite for edges',
    rationale: 'JSON too large at scale',
    consequences: 'Requires migration',
    proposedRequirement: null,
    affectedDomains: [],
    affectedFiles: [],
    sessionId: 'test-session',
    recordedAt: '2026-01-01T00:00:00.000Z',
    confidence: 'medium',
    syncedToSpecs: [],
    ...overrides,
  };
}

function makeStore(decisions: PendingDecision[]): DecisionStore {
  return { version: '1', sessionId: 'test-session', updatedAt: '2026-01-01T00:00:00.000Z', decisions };
}

describe('openloreSyncDecisions — status-transition guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refuses to promote a rejected decision by id; sync never runs', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'rejected', reviewNote: 'Rejected on review' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await expect(
      openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] }),
    ).rejects.toThrow(/rejected by a human/);
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });

  it('refuses to re-promote an already-synced decision by id', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'synced' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await expect(
      openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] }),
    ).rejects.toThrow(/already synced/);
    expect(syncApprovedDecisions).not.toHaveBeenCalled();
  });

  it('promotes and syncs a legal (verified) decision by id — lifecycle unchanged', async () => {
    const decision = makeDecision({ id: 'abc12345', status: 'verified' });
    vi.mocked(loadDecisionStore).mockResolvedValue(makeStore([decision]));

    await openloreSyncDecisions({ rootPath: '/test/project', ids: ['abc12345'] });

    expect(syncApprovedDecisions).toHaveBeenCalledWith(
      expect.objectContaining({
        decisions: expect.arrayContaining([
          expect.objectContaining({ id: 'abc12345', status: 'approved' }),
        ]),
      }),
      expect.anything(),
    );
  });
});

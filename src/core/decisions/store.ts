/**
 * Decision store — CRUD for .openlore/decisions/pending.json
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  OPENLORE_DIR,
  OPENLORE_DECISIONS_SUBDIR,
  DECISIONS_PENDING_FILE,
} from '../../constants.js';
import { fileExists } from '../../utils/command-helpers.js';
import { atomicWriteFile, casUpdate, quarantineCorrupt } from './atomic-store.js';
import type { PendingDecision, DecisionStore, DecisionStatus } from '../../types/index.js';

export function decisionsDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR);
}

function decisionsPath(rootPath: string): string {
  return join(decisionsDir(rootPath), DECISIONS_PENDING_FILE);
}

export async function loadDecisionStore(rootPath: string): Promise<DecisionStore> {
  const path = decisionsPath(rootPath);
  if (!(await fileExists(path))) {
    return emptyStore();
  }
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyStore();
    // A genuine read fault (not corruption) — quarantine so the file is preserved
    // and the loss is loud, never a silent empty store.
    await quarantineCorrupt(path, `read failed: ${(err as Error).message}`);
    return emptyStore();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Torn / hand-corrupted JSON: quarantine, never silently empty. Silent memory
    // loss presents absence as current fact. (harden-memory-integrity-invariant)
    await quarantineCorrupt(path, `invalid JSON: ${(err as Error).message}`);
    return emptyStore();
  }
  // Untrusted artifact: validate top-level shape before use. A malformed store
  // (non-object, or no `decisions` array) is quarantined rather than letting a
  // poisoned shape reach `store.decisions.*` downstream (mcp-security).
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { decisions?: unknown }).decisions)) {
    await quarantineCorrupt(path, 'invalid shape (missing decisions array)');
    return emptyStore();
  }
  const store = parsed as DecisionStore;
  if (typeof store.sequence !== 'number') store.sequence = 0; // legacy default
  return store;
}

export async function saveDecisionStore(rootPath: string, store: DecisionStore): Promise<void> {
  const updated: DecisionStore = {
    ...store,
    updatedAt: new Date().toISOString(),
    sequence: (store.sequence ?? 0) + 1,
  };
  await atomicWriteFile(decisionsPath(rootPath), JSON.stringify(updated, null, 2) + '\n');
}

/**
 * Concurrency-safe read-modify-write of the decision store. Loads, applies
 * `mutate` (a pure id-keyed merge such as {@link upsertDecisions} /
 * {@link patchDecision}), and commits under compare-and-swap so two concurrent
 * writers never lose a decision — on a conflict the mutate is re-applied to the
 * newer store. (harden-memory-integrity-invariant)
 */
export async function updateDecisionStore(
  rootPath: string,
  mutate: (store: DecisionStore) => DecisionStore,
): Promise<DecisionStore> {
  return casUpdate<DecisionStore>({
    storePath: decisionsPath(rootPath),
    load: () => loadDecisionStore(rootPath),
    mutate: (current) => ({ ...mutate(current), updatedAt: new Date().toISOString() }),
    serialize: (next) => JSON.stringify(next, null, 2) + '\n',
  });
}

/**
 * Merge incoming decisions into the store, deduplicating by id.
 * Existing decisions are never overwritten.
 */
export function upsertDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    if (!byId.has(d.id)) byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/**
 * Merge incoming decisions into the store, always overwriting by id.
 * Use this for consolidation output — consolidated decisions share IDs with
 * their original drafts (makeDecisionId is deterministic), so upsertDecisions
 * would silently no-op after patchDecision marks the originals rejected.
 */
export function replaceDecisions(store: DecisionStore, incoming: PendingDecision[]): DecisionStore {
  const byId = new Map(store.decisions.map((d) => [d.id, d]));
  for (const d of incoming) {
    byId.set(d.id, d);
  }
  return { ...store, decisions: [...byId.values()] };
}

/** Patch a single decision by id. Returns the updated store (not yet saved). */
export function patchDecision(
  store: DecisionStore,
  id: string,
  patch: Partial<PendingDecision>
): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.map((d) => (d.id === id ? { ...d, ...patch } : d)),
  };
}

export function getDecisionsByStatus(
  store: DecisionStore,
  status: DecisionStatus
): PendingDecision[] {
  return store.decisions.filter((d) => d.status === status);
}

export function getDecisionCount(store: DecisionStore): number {
  return store.decisions.length;
}

/** Status blocks the commit gate until resolved. */
export function isBlockingStatus(status: DecisionStatus): boolean {
  return status === 'verified' || status === 'approved';
}

/** Status requires a --sync run before committing. */
export function requiresSync(status: DecisionStatus): boolean {
  return status === 'approved';
}

/** Statuses excluded from the "activeDecisions" gate guard. */
export const INACTIVE_STATUSES: ReadonlySet<DecisionStatus> = new Set([
  'rejected', 'synced', 'phantom',
]);

/** Drop all inactive decisions — their content is already in ADRs / spec.md. */
export function purgeInactiveDecisions(store: DecisionStore): DecisionStore {
  return {
    ...store,
    decisions: store.decisions.filter((d) => !INACTIVE_STATUSES.has(d.status)),
  };
}

/** Stable 8-char ID derived from session + domain + title. */
export function makeDecisionId(sessionId: string, domain: string, title: string): string {
  return createHash('sha256').update(`${sessionId}:${domain}:${title}`).digest('hex').slice(0, 8);
}

/** Generate a new session ID for a commit cycle. */
export function newSessionId(): string {
  return createHash('sha256').update(`${Date.now()}-${Math.random()}`).digest('hex').slice(0, 12);
}

function emptyStore(): DecisionStore {
  return {
    version: '1',
    sessionId: newSessionId(),
    updatedAt: new Date().toISOString(),
    sequence: 0,
    decisions: [],
  };
}

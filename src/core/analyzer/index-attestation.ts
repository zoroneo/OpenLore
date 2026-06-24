/**
 * Index integrity attestation (change: add-index-integrity-attestation).
 *
 * OpenLore already refuses to lie about its *stores* — a torn write is prevented
 * atomically and a corrupt store is quarantined rather than silently replaced by an
 * empty one — because "silently losing persisted state presents absence as current
 * fact." The structural graph index (`.openlore/analysis/`) had no equivalent
 * guarantee: an interrupted, OOM-killed, partially-persisted, or schema-mismatched
 * build can load and answer while being materially incomplete, turning the negative
 * conclusions OpenLore is trusted for (`find_dead_code`, `select_tests`,
 * `analyze_impact`) into confident falsehoods.
 *
 * This module computes a deterministic **attestation** at build time (what a healthy
 * index of this repo should look like) and a pure **reconciliation verdict** at load
 * time (`healthy | degraded | mismatched`). It is a reconciliation, NOT a
 * re-extraction: it answers "did the build I just ran land intact and at the right
 * schema?", never "is the graph semantically correct."
 *
 * Determinism: integer counts + a content digest over a canonically-sorted projection
 * of the persisted production graph. No clock, no model, no sampling — byte-identical
 * across re-analyses of a fixed repository state.
 */

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { ARTIFACT_INDEX_ATTESTATION } from '../../constants.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';

/** Format version of the attestation record itself. Bump only on a shape change. */
export const ATTESTATION_VERSION = 1;

/**
 * Below this many committed functions a count *ratio* is not meaningful (a handful
 * of nodes makes "50% smaller" noise), so the ratio floor is skipped and only the
 * schema version decides — mirroring how the store guards exempt tiny/legacy cases.
 */
export const SMALL_REPO_MIN_FUNCTIONS = 20;

/**
 * The persisted production graph is `degraded` when it has dropped below this
 * fraction of what the build committed. A fixed, documented constant — generous
 * enough that the incremental watcher's normal add/remove drift never trips it, tight
 * enough that a truncated / half-persisted store (which collapses toward zero) does.
 */
export const DEGRADED_RATIO_FLOOR = 0.5;

/** Counts of the primary persisted production artifacts. */
export interface AttestationCounts {
  /** Distinct source files contributing production nodes. */
  files: number;
  /** Production (non-test) function/method nodes. */
  functions: number;
  /** Production call edges. */
  edges: number;
  /** Class / module nodes. */
  classes: number;
}

/**
 * The attestation record written alongside the index. A deterministic function of the
 * build: re-analyzing a fixed commit produces a byte-identical record.
 */
export interface IndexAttestation {
  attestationVersion: number;
  /** EdgeStore SCHEMA_VERSION the index was built at. */
  schemaVersion: number;
  /** What extraction committed (the production graph that was written). */
  committed: AttestationCounts;
  /** SHA-256 over a canonical projection of the committed production graph. */
  digest: string;
}

export type IntegrityVerdict = 'healthy' | 'degraded' | 'mismatched';

/** What a load actually found in the persisted store, to reconcile against the attestation. */
export interface PersistedCounts extends AttestationCounts {
  schemaVersion: number;
}

/** The computed verdict for an on-disk index, attached to a loaded context. */
export interface IndexIntegrity {
  verdict: IntegrityVerdict;
  /** Human-readable, actionable disclosure. */
  detail: string;
  committed: AttestationCounts;
  persisted: PersistedCounts;
}

/** Minimal node projection the digest/counts need (id + file). */
export interface AttNode { id: string; filePath: string }
/** Minimal edge projection the digest needs. */
export interface AttEdge { callerId: string; calleeId: string; calleeName: string }
/** Minimal class projection the digest needs. */
export interface AttClass { id: string }

/**
 * Canonical, order-independent content digest of the production graph. Sorting makes
 * it invariant to extraction/insert order; ids are stable (normalized relative paths).
 * This is the build-determinism + tamper-evidence stamp — see `reconcile` for why it
 * is deliberately NOT a load-time verdict driver.
 */
export function digestProductionGraph(
  schemaVersion: number,
  nodes: readonly AttNode[],
  edges: readonly AttEdge[],
  classes: readonly AttClass[],
): string {
  const h = createHash('sha256');
  h.update(`v${schemaVersion}\n`);
  h.update('N\n');
  for (const id of nodes.map(n => n.id).sort()) h.update(id + '\n');
  h.update('E\n');
  for (const e of edges.map(e => `${e.callerId}\t${e.calleeId}\t${e.calleeName}`).sort()) h.update(e + '\n');
  h.update('C\n');
  for (const id of classes.map(c => c.id).sort()) h.update(id + '\n');
  return h.digest('hex');
}

/**
 * Build the attestation from the in-memory production graph that was persisted. Counts
 * come from the production set (test nodes already excluded by the caller) so they
 * reconcile exactly with what a load recounts from the store. Files that failed to
 * parse are accounted for implicitly: they contribute no nodes, so the production
 * baseline already reflects them — no fabricated parse-failure number is recorded.
 */
export function computeAttestation(
  schemaVersion: number,
  nodes: readonly AttNode[],
  edges: readonly AttEdge[],
  classes: readonly AttClass[],
): IndexAttestation {
  const files = new Set<string>();
  for (const n of nodes) files.add(n.filePath);
  return {
    attestationVersion: ATTESTATION_VERSION,
    schemaVersion,
    committed: {
      files: files.size,
      functions: nodes.length,
      edges: edges.length,
      classes: classes.length,
    },
    digest: digestProductionGraph(schemaVersion, nodes, edges, classes),
  };
}

/** Write the attestation atomically alongside the index (mirrors the store-write ethos). */
export async function writeAttestation(outputDir: string, attestation: IndexAttestation): Promise<void> {
  await atomicWriteFile(
    join(outputDir, ARTIFACT_INDEX_ATTESTATION),
    JSON.stringify(attestation, null, 2),
  );
}

/**
 * Read the attestation, or null when absent/unreadable/foreign-version. A legacy index
 * built before this change has no attestation — we return null (unverifiable), never a
 * fabricated "healthy", consistent with the never-present-absence-as-fact ethos.
 */
export async function readAttestation(outputDir: string): Promise<IndexAttestation | null> {
  try {
    const raw = await readFile(join(outputDir, ARTIFACT_INDEX_ATTESTATION), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<IndexAttestation>;
    if (
      parsed === null || typeof parsed !== 'object' ||
      parsed.attestationVersion !== ATTESTATION_VERSION ||
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.digest !== 'string' ||
      typeof parsed.committed !== 'object' || parsed.committed === null
    ) {
      return null;
    }
    return parsed as IndexAttestation;
  } catch {
    return null;
  }
}

/**
 * Reconcile the persisted store against the attestation. Pure: a deterministic function
 * of the two count sets — no clock, no model, no re-extraction.
 *
 * Verdict drivers:
 *  - `mismatched` — the store's schema version differs from the attestation's. After a
 *    schema bump the store self-wipes and re-stamps to the current version, so an
 *    attestation written at the old version reconciles here. The index cannot be
 *    trusted as-is.
 *  - `degraded` — the persisted production counts have dropped below `DEGRADED_RATIO_FLOOR`
 *    of what the build committed (exempted for tiny repos). The build did not fully
 *    land / the store was truncated.
 *  - `healthy` — schema matches and counts are within tolerance (the store may legitimately
 *    have grown via incremental updates → ratio ≥ 1).
 *
 * The content digest is intentionally NOT a load-time driver: the incremental watcher
 * mutates the persisted store between full builds, so a digest-equality check would
 * false-positive on every incremental update. The digest stays a build-determinism and
 * tamper-evidence stamp (verified by tooling that compares fresh full builds).
 */
export function reconcile(attestation: IndexAttestation, persisted: PersistedCounts): IndexIntegrity {
  const base = { committed: attestation.committed, persisted };

  if (persisted.schemaVersion !== attestation.schemaVersion) {
    return {
      verdict: 'mismatched',
      detail:
        `Index schema version ${persisted.schemaVersion} does not match the attestation's ` +
        `${attestation.schemaVersion} — the on-disk index was built at a different schema and cannot be ` +
        `trusted as-is. Re-run "openlore analyze --force" to rebuild.`,
      ...base,
    };
  }

  // Small-repo exemption: a count ratio is not meaningful at tiny scale.
  if (attestation.committed.functions < SMALL_REPO_MIN_FUNCTIONS) {
    return { verdict: 'healthy', detail: 'Index integrity verified (small-repo exemption: schema matches).', ...base };
  }

  const fnRatio = persisted.functions / attestation.committed.functions;
  const edgeRatio = attestation.committed.edges === 0 ? 1 : persisted.edges / attestation.committed.edges;
  const ratio = Math.min(fnRatio, edgeRatio);

  if (ratio < DEGRADED_RATIO_FLOOR) {
    return {
      verdict: 'degraded',
      detail:
        `Persisted index is materially smaller than the build committed ` +
        `(${persisted.functions}/${attestation.committed.functions} functions, ` +
        `${persisted.edges}/${attestation.committed.edges} edges) — the build did not fully land or the ` +
        `store was truncated. Negative conclusions (dead-code / no-reaching-test / blast-radius) may be ` +
        `false. Re-run "openlore analyze --force" to rebuild.`,
      ...base,
    };
  }

  return { verdict: 'healthy', detail: 'Index integrity verified (counts reconcile, schema matches).', ...base };
}

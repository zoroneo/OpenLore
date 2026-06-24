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
import { readFile, stat } from 'node:fs/promises';
import { ARTIFACT_INDEX_ATTESTATION } from '../../constants.js';
import { atomicWriteFile } from '../decisions/atomic-store.js';

/**
 * Upper bound on the attestation file size read at load. The attestation lives under
 * `.openlore/analysis/` — untrusted on-disk input (mcp-security: Untrusted Artifact
 * Deserialization Safety) read on every cache miss. A real attestation is < 1 KB; a
 * generous 1 MB cap fails closed on a poisoned/oversized file without an unbounded read.
 */
const ATTESTATION_MAX_BYTES = 1024 * 1024;

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

/** The subset of EdgeStore the counts refresh needs — keeps this module store-agnostic. */
export interface AttestationCountSource {
  countFiles(): number;
  countNodes(): number;
  countEdges(): number;
  countClasses(): number;
  getSchemaVersion(): number;
}

/**
 * Keep an existing attestation's `committed` counts in lockstep with the live store
 * after an incremental watcher mutation, so the load-time verdict stays correct
 * (change: add-index-integrity-attestation).
 *
 * The build-time attestation is a snapshot of the *full* build's production graph. The
 * incremental watcher legitimately deletes nodes/edges for changed or removed files
 * between full builds; left alone, the persisted store would drift below the build-time
 * counts and `reconcile` would FALSELY report `degraded` on a perfectly valid, current
 * index. Refreshing the counts from the store (cheap COUNT queries) keeps `degraded`
 * meaning what it should: the store is materially smaller than the *most recent* persist,
 * i.e. real truncation/corruption — never ordinary incremental editing.
 *
 * Refreshes COUNTS ONLY. The schema version and digest belong to the full build that wrote
 * the attestation and are carried forward verbatim. Critically, the refresh REFUSES to
 * cross a schema boundary: if the live store's schema has diverged from the attestation's
 * (e.g. a watcher batch landing mid schema-bump rebuild), it leaves the attestation
 * untouched so the load-time verdict still sees `mismatched` — a refresh must never silently
 * "upgrade" an old-schema attestation and mask the very drift this feature exists to catch.
 *
 * No-ops when no attestation exists (a legacy/unverifiable index stays unverifiable — we
 * never fabricate one from a partial incremental state). Best-effort and cheap; callers
 * invoke it as additive fire-and-forget.
 */
export async function refreshAttestationCounts(
  outputDir: string,
  store: AttestationCountSource,
): Promise<void> {
  const existing = await readAttestation(outputDir);
  if (!existing) return;
  // Never refresh across a schema boundary — that would mask a `mismatched` verdict.
  if (store.getSchemaVersion() !== existing.schemaVersion) return;
  await writeAttestation(outputDir, {
    ...existing,
    committed: {
      files: store.countFiles(),
      functions: store.countNodes(),
      edges: store.countEdges(),
      classes: store.countClasses(),
    },
  });
}

/**
 * Read the attestation, or null when absent/unreadable/foreign-version. A legacy index
 * built before this change has no attestation — we return null (unverifiable), never a
 * fabricated "healthy", consistent with the never-present-absence-as-fact ethos.
 */
export async function readAttestation(outputDir: string): Promise<IndexAttestation | null> {
  try {
    const path = join(outputDir, ARTIFACT_INDEX_ATTESTATION);
    // Bound the read: untrusted on-disk artifact (mcp-security). Fail closed on oversized.
    if ((await stat(path)).size > ATTESTATION_MAX_BYTES) return null;
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as Partial<IndexAttestation>;
    if (
      parsed === null || typeof parsed !== 'object' ||
      parsed.attestationVersion !== ATTESTATION_VERSION ||
      typeof parsed.schemaVersion !== 'number' ||
      typeof parsed.digest !== 'string' ||
      !isAttestationCounts(parsed.committed)
    ) {
      // Fail closed: a malformed/partial attestation (e.g. `committed: {}`) is treated as
      // unverifiable, NEVER trusted. Without the numeric-field check, an undefined count
      // would make `reconcile`'s ratio NaN and `NaN < floor` false — silently fabricating
      // a `healthy` verdict, the exact failure this feature exists to prevent.
      return null;
    }
    return parsed as IndexAttestation;
  } catch {
    return null;
  }
}

/** True only when every reconciliation count is a finite number. */
function isAttestationCounts(c: unknown): c is AttestationCounts {
  if (c === null || typeof c !== 'object') return false;
  const r = c as Record<string, unknown>;
  return (['files', 'functions', 'edges', 'classes'] as const)
    .every(k => typeof r[k] === 'number' && Number.isFinite(r[k]));
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

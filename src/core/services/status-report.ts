/**
 * Status report — the deterministic, local answer to "what is OpenLore doing in
 * this repo, right now?" (change: add-substrate-status-surface / SingleStatusConclusion).
 *
 * A background tool earns invisibility only if the user can interrogate it in one
 * place. Today the answer is scattered across five commands — `doctor`,
 * `features`, `decisions --status`, `connect list`, and the update notifier — and
 * none answers the autopilot-era questions: is my index fresh, is anything
 * running, what did you accept for me, is anything waiting on me?
 *
 * This module is the single source of truth for that pane. It COMPOSES existing
 * readers only — the index-integrity attestation, the edge-store stale region,
 * config-manager, install's `surfaceStatus`, the decisions store + ledger, and
 * the update-notifier cache — into one read-only report. It is pure data +
 * detection: no rendering, no LLM, no network, and — critically — NO WRITES. The
 * edge store is opened read-only so a `status` run mutates nothing (the read-only
 * guarantee the spec requires).
 *
 * Sections whose optional dependencies have not landed (a repair service, global
 * wiring scope) render their current truth, never an error — so `status` degrades
 * gracefully as the onboarding-autopilot arc fills in.
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  ANALYSIS_AGE_WARNING_HOURS,
  ARTIFACT_CALL_GRAPH_DB,
  ARTIFACT_LLM_CONTEXT,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DIR,
} from '../../constants.js';
import { readOpenLoreConfig } from './config-manager.js';
import { readAttestation, reconcile, type IntegrityVerdict } from '../analyzer/index-attestation.js';
import { surfaceStatus, type SurfaceStatus } from '../../cli/install/index.js';
import { loadDecisionStore, isBlockingStatus } from '../decisions/store.js';
import { readLedger, type LedgerEntry } from '../decisions/ledger.js';
import { isNewer, type UpdateCache } from './update-notifier.js';

// ── Section shapes ────────────────────────────────────────────────────────────

/** Index freshness verdict, extended with `unverifiable` (no attestation to check). */
export type IndexVerdict = IntegrityVerdict | 'unverifiable';

export interface IndexSection {
  /** An analysis artifact (llm-context.json) exists. */
  exists: boolean;
  /** Age of the analysis in hours (null when absent). */
  ageHours: number | null;
  /** Human label: "fresh" / "3.2h old" (null when absent). */
  ageLabel: string | null;
  /** True when age exceeds doctor's own warning threshold. */
  stale: boolean;
  /** Integrity verdict from the build-time attestation (null when no index). */
  integrity: IndexVerdict | null;
  /** Count of files in the explicit stale region (null when no edge store). */
  staleFileCount: number | null;
  /**
   * A background build/repair in flight, with its trigger reason. Always null
   * today: the cross-process repair service (make-index-self-healing) has not
   * landed, and the cold-start latch is per-process and not observable from here.
   * Modeled so the row lights up honestly once that change ships.
   */
  repairInFlight: { reason: string } | null;
  nextAction?: string;
}

export type SearchMode = 'keyword' | 'local-embeddings' | 'remote-endpoint';

export interface SearchSection {
  mode: SearchMode;
  detail: string;
  nextAction?: string;
}

export interface LiveSection {
  /** A validated serve.json descriptor was found and its pid is alive. */
  serveDaemonRunning: boolean;
  pid?: number;
  port?: number;
  detail: string;
}

export interface WiringSection {
  surfaces: SurfaceStatus[];
  connectedCount: number;
  /**
   * Whether any adapter reports a user (global) scope. False until
   * unify-onboarding-entrypoint adds it; the row then shows global wiring too.
   */
  globalScopeSupported: boolean;
  nextAction?: string;
}

export type GateMode = 'autopilot' | 'review' | 'off';

export interface GovernanceSection {
  /** The pre-commit decisions gate is installed. */
  gateInstalled: boolean;
  mode: GateMode;
  /** Decisions blocking a commit until a human acts (verified/approved). */
  pendingOnHuman: number;
  /** Auto-accepted decisions a human has not yet reviewed. */
  autoAcceptedUnreviewed: number;
  /** Most recent ledger entries (newest first, at most 3). */
  recentLedger: LedgerEntry[];
  nextAction?: string;
}

export interface VersionSection {
  current: string;
  /** The newer version cached by the update notifier, or null. */
  updateAvailable: string | null;
  nextAction?: string;
}

export interface StatusReport {
  root: string;
  /** Any OpenLore state here (a `.openlore` dir or a connected surface). */
  configured: boolean;
  index: IndexSection;
  search: SearchSection;
  live: LiveSection;
  wiring: WiringSection;
  governance: GovernanceSection;
  version: VersionSection;
}

export interface StatusOptions {
  /** Clock injection (tests). Defaults to Date.now. */
  now?: () => number;
  /** Current openlore version (defaults to this package's version). */
  currentVersion?: string;
  /** Override the update-notifier cache file (tests). */
  updateCacheFile?: string;
}

// ── Index ─────────────────────────────────────────────────────────────────────

/**
 * Read the index's integrity verdict and stale-file count WITHOUT mutating the
 * store. Opens the SQLite db read-only (no WAL pragma, no checkpoint) so `status`
 * never writes. Fail-soft: any fault yields an unverifiable/absent truth, never a
 * throw. Deliberately does not run the `degraded` WAL-checkpoint retry that the
 * hot read path does — that retry writes, and `status` must not.
 */
async function readIndexIntegrity(
  analysisDir: string,
): Promise<{ integrity: IndexVerdict | null; staleFileCount: number | null }> {
  const dbPath = join(analysisDir, ARTIFACT_CALL_GRAPH_DB);
  if (!existsSync(dbPath)) return { integrity: null, staleFileCount: null };

  let db: DatabaseSync | undefined;
  try {
    // Open with SQLite's `immutable=1` — a truly read-only open that reads the db
    // file directly and creates NO -wal/-shm sidecars (a plain readOnly open of a
    // WAL db still writes those). This is what keeps `status` from mutating the
    // directory. Trade-off: immutable ignores any un-checkpointed WAL, so we read
    // the last checkpointed state — a valid, honest snapshot that never blocks or
    // writes, exactly the contract status wants.
    const uri = `${pathToFileURL(dbPath).href}?immutable=1`;
    db = new DatabaseSync(uri, { readOnly: true });
    const one = (sql: string): number => {
      const row = db!.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const staleFileCount = one('SELECT COUNT(*) as n FROM stale_files');

    const attestation = await readAttestation(analysisDir);
    if (!attestation) return { integrity: 'unverifiable', staleFileCount };

    const schemaRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
      | { version: number }
      | undefined;
    const verdict = reconcile(attestation, {
      schemaVersion: schemaRow?.version ?? attestation.schemaVersion,
      files: one('SELECT COUNT(DISTINCT file_path) as n FROM nodes WHERE is_external = 0'),
      functions: one('SELECT COUNT(*) as n FROM nodes WHERE is_external = 0'),
      edges: one('SELECT COUNT(*) as n FROM edges'),
      classes: one('SELECT COUNT(*) as n FROM classes'),
    });
    return { integrity: verdict.verdict, staleFileCount };
  } catch {
    return { integrity: 'unverifiable', staleFileCount: null };
  } finally {
    try {
      db?.close();
    } catch {
      /* best-effort close */
    }
  }
}

async function collectIndex(root: string, now: () => number): Promise<IndexSection> {
  const analysisDir = join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
  const contextPath = join(analysisDir, ARTIFACT_LLM_CONTEXT);

  let exists = false;
  let ageHours: number | null = null;
  let ageLabel: string | null = null;
  try {
    const s = await stat(contextPath);
    exists = true;
    ageHours = (now() - s.mtime.getTime()) / 3_600_000;
    ageLabel = ageHours < 1 ? 'fresh' : `${ageHours.toFixed(1)}h old`;
  } catch {
    /* no analysis */
  }

  if (!exists) {
    return {
      exists: false,
      ageHours: null,
      ageLabel: null,
      stale: false,
      integrity: null,
      staleFileCount: null,
      repairInFlight: null,
      nextAction: 'openlore analyze — build the structural index',
    };
  }

  const { integrity, staleFileCount } = await readIndexIntegrity(analysisDir);
  const stale = ageHours !== null && ageHours > ANALYSIS_AGE_WARNING_HOURS;

  let nextAction: string | undefined;
  if (integrity === 'mismatched') {
    nextAction = 'openlore analyze --force — index does not match its attestation';
  } else if (stale || (staleFileCount ?? 0) > 0) {
    nextAction = 'openlore analyze — refresh the index';
  }

  return {
    exists: true,
    ageHours,
    ageLabel,
    stale,
    integrity,
    staleFileCount,
    repairInFlight: null,
    nextAction,
  };
}

// ── Search ────────────────────────────────────────────────────────────────────

async function collectSearch(root: string): Promise<SearchSection> {
  let config;
  try {
    config = await readOpenLoreConfig(root);
  } catch {
    /* no config — keyword default */
  }
  const emb = config?.embedding;

  if (emb?.provider === 'local') {
    return {
      mode: 'local-embeddings',
      detail: `on-device embedder · ${emb.model ?? 'default model'} · no key`,
    };
  }
  const baseUrl = emb?.baseUrl ?? process.env.EMBED_BASE_URL;
  if (baseUrl) {
    return {
      mode: 'remote-endpoint',
      detail: `remote embeddings · ${baseUrl.replace(/\/$/, '')}`,
    };
  }
  return {
    mode: 'keyword',
    detail: 'BM25 keyword search (zero-config default)',
    nextAction: 'openlore embed --local — add on-device semantic ranking (optional)',
  };
}

// ── Live ──────────────────────────────────────────────────────────────────────

/** True when a pid is alive (signal 0 is an existence/permission probe — no side effect). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but we may not signal it — still alive.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function collectLive(root: string): Promise<LiveSection> {
  const descPath = join(root, OPENLORE_DIR, 'serve.json');
  try {
    const raw = JSON.parse(await readFile(descPath, 'utf-8')) as {
      pid?: unknown;
      port?: unknown;
    };
    const pid = typeof raw.pid === 'number' && Number.isInteger(raw.pid) && raw.pid > 0 ? raw.pid : undefined;
    const port = typeof raw.port === 'number' ? raw.port : undefined;
    if (pid && pidAlive(pid)) {
      return {
        serveDaemonRunning: true,
        pid,
        port,
        detail: `serve daemon running · pid ${pid}${port ? ` · port ${port}` : ''}`,
      };
    }
    return {
      serveDaemonRunning: false,
      detail: 'serve daemon descriptor is stale (process not running)',
    };
  } catch {
    return {
      serveDaemonRunning: false,
      detail: 'no serve daemon running (the MCP server, when wired, runs on demand)',
    };
  }
}

// ── Wiring ────────────────────────────────────────────────────────────────────

async function collectWiring(root: string): Promise<WiringSection> {
  let surfaces: SurfaceStatus[] = [];
  try {
    surfaces = await surfaceStatus(root);
  } catch {
    /* detection fault — report nothing connected rather than throw */
  }
  const connectedCount = surfaces.filter((s) => s.connected).length;
  return {
    surfaces,
    connectedCount,
    globalScopeSupported: false, // set true when unify-onboarding-entrypoint lands user scope
    nextAction:
      connectedCount === 0 ? 'openlore install — wire your coding agent to OpenLore' : undefined,
  };
}

// ── Governance ────────────────────────────────────────────────────────────────

/** The marker line the decisions pre-commit hook writes (see decisions.ts HOOK_MARKER). */
const DECISIONS_HOOK_MARKER = '# openlore-decisions-hook';

function gateInstalledSync(root: string): boolean {
  try {
    const hook = readFileSync(join(root, '.git', 'hooks', 'pre-commit'), 'utf-8');
    return hook.includes(DECISIONS_HOOK_MARKER);
  } catch {
    return false;
  }
}

async function collectGovernance(root: string): Promise<GovernanceSection> {
  const gateInstalled = gateInstalledSync(root);

  let autopilot = false;
  try {
    const config = await readOpenLoreConfig(root);
    autopilot = config?.governance?.autopilot === true;
  } catch {
    /* no config */
  }
  const mode: GateMode = autopilot ? 'autopilot' : gateInstalled ? 'review' : 'off';

  let pendingOnHuman = 0;
  let autoAcceptedUnreviewed = 0;
  try {
    const store = await loadDecisionStore(root);
    pendingOnHuman = store.decisions.filter((d) => isBlockingStatus(d.status)).length;
    autoAcceptedUnreviewed = store.decisions.filter(
      (d) => d.status === 'auto-approved' && !d.humanReviewedAt,
    ).length;
  } catch {
    /* no decision store */
  }

  let recentLedger: LedgerEntry[] = [];
  try {
    const ledger = await readLedger(root);
    recentLedger = ledger.slice(-3).reverse();
  } catch {
    /* no ledger */
  }

  let nextAction: string | undefined;
  if (pendingOnHuman > 0) {
    nextAction = 'openlore decisions --consolidate --gate — decisions await your review';
  } else if (autoAcceptedUnreviewed > 0) {
    nextAction = 'openlore decisions review — see what autopilot accepted for you';
  } else if (!gateInstalled) {
    nextAction = 'openlore setup — install the decisions commit gate (optional)';
  }

  return {
    gateInstalled,
    mode,
    pendingOnHuman,
    autoAcceptedUnreviewed,
    recentLedger,
    nextAction,
  };
}

// ── Version ───────────────────────────────────────────────────────────────────

function defaultUpdateCacheFile(): string {
  return join(homedir(), OPENLORE_DIR, 'update-check.json');
}

function readPackageVersion(): string {
  try {
    const url = new URL('../../../package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(url, 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function collectVersion(opts: StatusOptions): VersionSection {
  const current = opts.currentVersion ?? readPackageVersion();
  const cacheFile = opts.updateCacheFile ?? defaultUpdateCacheFile();
  let updateAvailable: string | null = null;
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf-8')) as Partial<UpdateCache>;
    if (typeof parsed.latest === 'string' && isNewer(current, parsed.latest)) {
      updateAvailable = parsed.latest;
    }
  } catch {
    /* no cache / unreadable — no update signal */
  }
  return {
    current,
    updateAvailable,
    nextAction: updateAvailable ? 'openlore update — a newer version is available' : undefined,
  };
}

// ── Compose ───────────────────────────────────────────────────────────────────

/**
 * Assemble the full status report for `root`. Read-only, no LLM, no network,
 * sub-second. Every section is fail-soft: an absent dependency renders its
 * current truth, never an error.
 */
export async function collectStatusReport(
  root: string,
  opts: StatusOptions = {},
): Promise<StatusReport> {
  const now = opts.now ?? Date.now;

  const [index, search, live, wiring, governance] = await Promise.all([
    collectIndex(root, now),
    collectSearch(root),
    collectLive(root),
    collectWiring(root),
    collectGovernance(root),
  ]);
  const version = collectVersion(opts);

  const configured = existsSync(join(root, OPENLORE_DIR)) || wiring.connectedCount > 0;

  return { root, configured, index, search, live, wiring, governance, version };
}

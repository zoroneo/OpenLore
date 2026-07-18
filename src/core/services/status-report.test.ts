/**
 * Tests for the status report (change: add-substrate-status-surface /
 * SingleStatusConclusion). Guards that every section composes from existing
 * signals deterministically, that absent optional dependencies degrade to their
 * current truth (never an error), that a bare repo yields the single install
 * action, that a `status` collection MUTATES NO FILE, and that it is fast.
 *
 * Plain .test.ts so CI runs it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readdir, readFile, stat, utimes } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectStatusReport } from './status-report.js';
import { EdgeStore, SCHEMA_VERSION } from './edge-store.js';
import { writeAttestation } from '../analyzer/index-attestation.js';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
  OPENLORE_DECISIONS_SUBDIR,
  ARTIFACT_LLM_CONTEXT,
  ARTIFACT_CALL_GRAPH_DB,
  DECISIONS_PENDING_FILE,
  DECISIONS_LEDGER_FILE,
} from '../../constants.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'openlore-status-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── fixture helpers ─────────────────────────────────────────────────────────

const analysisDir = (): string => join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
const decisionsPath = (): string => join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_PENDING_FILE);
const ledgerPath = (): string => join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR, DECISIONS_LEDGER_FILE);

async function writeConfig(extra: Record<string, unknown>): Promise<void> {
  await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
  await writeFile(
    join(dir, OPENLORE_DIR, 'config.json'),
    JSON.stringify({ version: '1.0.0', projectType: 'nodejs', openspecPath: 'openspec', ...extra }, null, 2),
  );
}

/** Write an llm-context.json so the index "exists"; optionally back-date it. */
async function writeAnalysisArtifact(ageHours = 0): Promise<void> {
  await mkdir(analysisDir(), { recursive: true });
  const p = join(analysisDir(), ARTIFACT_LLM_CONTEXT);
  await writeFile(p, JSON.stringify({ functions: [] }));
  if (ageHours > 0) {
    const when = new Date(Date.now() - ageHours * 3_600_000);
    await utimes(p, when, when);
  }
}

/** Build a real edge store + a matching (small-repo) attestation, then close it. */
async function buildIndexDb(opts: { stale?: string[]; attestation?: boolean; schemaOffset?: number } = {}): Promise<void> {
  await mkdir(analysisDir(), { recursive: true });
  const dbPath = join(analysisDir(), ARTIFACT_CALL_GRAPH_DB);
  const es = EdgeStore.open(dbPath);
  if (opts.stale?.length) es.markFilesStale(opts.stale);
  es.close(); // fold WAL so the file is self-contained
  if (opts.attestation !== false) {
    await writeAttestation(analysisDir(), {
      attestationVersion: 1,
      schemaVersion: SCHEMA_VERSION + (opts.schemaOffset ?? 0),
      // Small-repo counts (< 20 functions) so the ratio floor is exempt: a real
      // read of the empty store still reconciles `healthy` when the schema matches.
      committed: { files: 3, functions: 5, edges: 4, classes: 1 },
      digest: 'test-digest',
    });
  }
}

async function writeStore(decisions: Array<Record<string, unknown>>): Promise<void> {
  await mkdir(join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR), { recursive: true });
  await writeFile(
    decisionsPath(),
    JSON.stringify({ version: '1', sessionId: 's', updatedAt: '2026-07-18T00:00:00Z', sequence: 1, decisions }),
  );
}

// ── section: index ────────────────────────────────────────────────────────────

describe('status: index section', () => {
  it('absent index → exists=false with an analyze next action', async () => {
    const r = await collectStatusReport(dir);
    expect(r.index.exists).toBe(false);
    expect(r.index.integrity).toBeNull();
    expect(r.index.staleFileCount).toBeNull();
    expect(r.index.nextAction).toMatch(/analyze/);
  });

  it('real db + matching attestation → integrity healthy (read via immutable, no mutation)', async () => {
    await writeAnalysisArtifact();
    await buildIndexDb();
    const r = await collectStatusReport(dir);
    expect(r.index.exists).toBe(true);
    expect(r.index.integrity).toBe('healthy');
    expect(r.index.staleFileCount).toBe(0);
    expect(r.index.ageLabel).toBe('fresh');
  });

  it('db present but no attestation → unverifiable, never a fabricated verdict', async () => {
    await writeAnalysisArtifact();
    await buildIndexDb({ attestation: false });
    const r = await collectStatusReport(dir);
    expect(r.index.integrity).toBe('unverifiable');
  });

  it('schema-skewed attestation → mismatched with a --force next action', async () => {
    await writeAnalysisArtifact();
    await buildIndexDb({ schemaOffset: -1 });
    const r = await collectStatusReport(dir);
    expect(r.index.integrity).toBe('mismatched');
    expect(r.index.nextAction).toMatch(/--force/);
  });

  it('files in the stale region are counted and drive a refresh action', async () => {
    await writeAnalysisArtifact();
    await buildIndexDb({ stale: ['a.ts', 'b.ts'] });
    const r = await collectStatusReport(dir);
    expect(r.index.staleFileCount).toBe(2);
    expect(r.index.nextAction).toMatch(/refresh/);
  });

  it('an aged analysis is flagged stale', async () => {
    await writeAnalysisArtifact(48); // older than ANALYSIS_AGE_WARNING_HOURS (24)
    const r = await collectStatusReport(dir);
    expect(r.index.stale).toBe(true);
    expect(r.index.ageLabel).toMatch(/h old/);
    expect(r.index.nextAction).toMatch(/refresh/);
  });
});

// ── section: search ─────────────────────────────────────────────────────────

describe('status: search section', () => {
  it('no config → keyword (BM25) default with an embed hint', async () => {
    const r = await collectStatusReport(dir);
    expect(r.search.mode).toBe('keyword');
    expect(r.search.nextAction).toMatch(/embed/);
  });

  it('local embedding provider → local-embeddings', async () => {
    await writeConfig({ embedding: { provider: 'local', model: 'bge-small' } });
    const r = await collectStatusReport(dir);
    expect(r.search.mode).toBe('local-embeddings');
    expect(r.search.detail).toMatch(/bge-small/);
  });

  it('remote baseUrl → remote-endpoint', async () => {
    await writeConfig({ embedding: { provider: 'remote', baseUrl: 'http://localhost:8080/v1', model: 'x' } });
    const r = await collectStatusReport(dir);
    expect(r.search.mode).toBe('remote-endpoint');
    expect(r.search.detail).toMatch(/localhost:8080/);
  });
});

// ── section: governance ───────────────────────────────────────────────────────

describe('status: governance section', () => {
  it('no gate, no config → mode off with a setup hint', async () => {
    const r = await collectStatusReport(dir);
    expect(r.governance.gateInstalled).toBe(false);
    expect(r.governance.mode).toBe('off');
    expect(r.governance.nextAction).toMatch(/setup/);
  });

  it('gate installed without autopilot → review mode', async () => {
    await mkdir(join(dir, '.git', 'hooks'), { recursive: true });
    await writeFile(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\n# openlore-decisions-hook\n');
    const r = await collectStatusReport(dir);
    expect(r.governance.gateInstalled).toBe(true);
    expect(r.governance.mode).toBe('review');
  });

  it('autopilot config + auto-accepted unreviewed decision → autopilot mode + review action', async () => {
    await writeConfig({ governance: { autopilot: true } });
    await writeStore([
      { id: 'aaaaaaaa', title: 'Auto one', status: 'auto-approved', approvedBy: 'autopilot' },
      { id: 'bbbbbbbb', title: 'Auto two, reviewed', status: 'auto-approved', humanReviewedAt: '2026-07-18T00:00:00Z' },
    ]);
    const r = await collectStatusReport(dir);
    expect(r.governance.mode).toBe('autopilot');
    expect(r.governance.autoAcceptedUnreviewed).toBe(1); // the reviewed one is excluded
    expect(r.governance.nextAction).toMatch(/review/);
  });

  it('a blocking decision takes precedence and surfaces the consolidate action', async () => {
    await writeStore([{ id: 'cccccccc', title: 'Pending', status: 'verified' }]);
    const r = await collectStatusReport(dir);
    expect(r.governance.pendingOnHuman).toBe(1);
    expect(r.governance.nextAction).toMatch(/consolidate/);
  });

  it('recent ledger entries are shown newest-first, capped at 3', async () => {
    await mkdir(join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR), { recursive: true });
    const line = (id: string, to: string) => JSON.stringify({ id, title: `t-${id}`, from: null, to, actor: 'autopilot', at: '2026-07-18T00:00:00Z' });
    await writeFile(ledgerPath(), [line('d1', 'verified'), line('d2', 'auto-approved'), line('d3', 'synced'), line('d4', 'synced')].join('\n') + '\n');
    const r = await collectStatusReport(dir);
    expect(r.governance.recentLedger.map((e) => e.id)).toEqual(['d4', 'd3', 'd2']);
  });
});

// ── section: wiring / live / version ──────────────────────────────────────────

describe('status: wiring, live, version', () => {
  it('a bare repo has no connected surfaces and an install action', async () => {
    const r = await collectStatusReport(dir);
    expect(r.wiring.connectedCount).toBe(0);
    expect(r.wiring.globalScopeSupported).toBe(false);
    expect(r.wiring.nextAction).toMatch(/install/);
  });

  it('no serve.json → serve daemon not running (honest, not an error)', async () => {
    const r = await collectStatusReport(dir);
    expect(r.live.serveDaemonRunning).toBe(false);
    expect(r.live.detail).toMatch(/no serve daemon/);
  });

  it('a stale serve.json (dead pid) is reported as not running', async () => {
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    // pid 2^31-1 is effectively never a live process.
    await writeFile(join(dir, OPENLORE_DIR, 'serve.json'), JSON.stringify({ pid: 2147483646, port: 7777, host: '127.0.0.1' }));
    const r = await collectStatusReport(dir);
    expect(r.live.serveDaemonRunning).toBe(false);
    expect(r.live.detail).toMatch(/stale/);
  });

  it('a live pid (this process) is reported as running', async () => {
    await mkdir(join(dir, OPENLORE_DIR), { recursive: true });
    await writeFile(join(dir, OPENLORE_DIR, 'serve.json'), JSON.stringify({ pid: process.pid, port: 7777, host: '127.0.0.1' }));
    const r = await collectStatusReport(dir);
    expect(r.live.serveDaemonRunning).toBe(true);
    expect(r.live.pid).toBe(process.pid);
  });

  it('a newer cached version surfaces an update-available signal', async () => {
    const cacheFile = join(dir, 'update-check.json');
    await writeFile(cacheFile, JSON.stringify({ latest: '99.0.0', checkedAt: Date.now() }));
    const r = await collectStatusReport(dir, { currentVersion: '1.0.0', updateCacheFile: cacheFile });
    expect(r.version.updateAvailable).toBe('99.0.0');
    expect(r.version.nextAction).toMatch(/update/);
  });

  it('no cache → no update signal (never a fabricated one)', async () => {
    const r = await collectStatusReport(dir, { currentVersion: '1.0.0', updateCacheFile: join(dir, 'nope.json') });
    expect(r.version.updateAvailable).toBeNull();
    expect(r.version.current).toBe('1.0.0');
  });
});

// ── configured degradation ────────────────────────────────────────────────────

describe('status: configured flag (bare-repo degradation)', () => {
  it('a repo with no .openlore and no wiring is not configured', async () => {
    const r = await collectStatusReport(dir);
    expect(r.configured).toBe(false);
  });

  it('presence of a .openlore dir marks the repo configured', async () => {
    await writeConfig({});
    const r = await collectStatusReport(dir);
    expect(r.configured).toBe(true);
  });
});

// ── read-only guarantee ───────────────────────────────────────────────────────

describe('status: read-only guarantee', () => {
  async function snapshot(root: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    async function walk(p: string): Promise<void> {
      for (const ent of await readdir(p, { withFileTypes: true })) {
        const full = join(p, ent.name);
        if (ent.isDirectory()) {
          await walk(full);
        } else {
          const [buf, st] = await Promise.all([readFile(full), stat(full)]);
          out.set(full, `${createHash('sha256').update(buf).digest('hex')}:${st.mtimeMs}`);
        }
      }
    }
    await walk(root);
    return out;
  }

  it('collecting a full report mutates no file (content, mtime, and file set unchanged)', async () => {
    // A rich fixture that exercises every reader that touches disk.
    await writeConfig({ governance: { autopilot: true }, embedding: { provider: 'local' } });
    await writeAnalysisArtifact();
    await buildIndexDb({ stale: ['x.ts'] });
    await writeStore([{ id: 'aaaaaaaa', title: 'A', status: 'auto-approved' }]);
    await mkdir(join(dir, OPENLORE_DIR, OPENLORE_DECISIONS_SUBDIR), { recursive: true });
    await writeFile(ledgerPath(), JSON.stringify({ id: 'aaaaaaaa', title: 'A', from: null, to: 'auto-approved', actor: 'autopilot', at: 'z' }) + '\n');
    await writeFile(join(dir, OPENLORE_DIR, 'serve.json'), JSON.stringify({ pid: 2147483646, port: 1, host: '127.0.0.1' }));

    const before = await snapshot(dir);
    await collectStatusReport(dir);
    const after = await snapshot(dir);

    // No file added, removed, or changed — the immutable DB open must not create
    // -wal/-shm sidecars, and no reader may write.
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [k, v] of before) expect(after.get(k), `file changed: ${k}`).toBe(v);
  });
});

// ── latency bound ─────────────────────────────────────────────────────────────

describe('status: latency', () => {
  it('a built fixture collects well under a second', async () => {
    await writeConfig({});
    await writeAnalysisArtifact();
    await buildIndexDb();
    const t0 = Date.now();
    await collectStatusReport(dir);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

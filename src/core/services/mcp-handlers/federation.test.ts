/**
 * federation_status handler tests (change: harden-federation-freshness).
 *
 * Two guarantees: a repo registered before its first analyze is disclosed as
 * `unbaselined` (never a freshness-checked `indexed` forever) and its baseline is
 * adopted on observation so later drift is caught as `stale`; and a corrupt
 * federation registry degrades to a conclusion-shaped `registry-unreadable` result
 * instead of throwing a raw exception through the transport.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleFederationStatus } from './federation.js';
import { addRepo, federationManifestPath } from '../../federation/registry.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../../constants.js';

let home: string;
const peers: string[] = [];

function makePeer(name: string, fingerprint?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fedh-peer-${name}-`));
  peers.push(dir);
  if (fingerprint !== undefined) writeFingerprint(dir, fingerprint);
  return dir;
}

function writeFingerprint(dir: string, hash: string): void {
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash, computedAt: '2026-07-19T00:00:00.000Z', fileCount: 1 }));
}

type StatusReport = {
  code?: string;
  message?: string;
  registered?: number;
  indexed?: number;
  unbaselined?: number;
  consultable?: number;
  adopted?: string[];
  repos?: Array<{ name: string; state: string }>;
  note?: string;
};

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fedh-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const p of peers.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('handleFederationStatus', () => {
  it('discloses a pre-analyze registration as unbaselined, adopts on observation, then detects drift', async () => {
    const peer = makePeer('a'); // registered with no index → empty stored fingerprint
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h1'); // index built after registration

    const first = (await handleFederationStatus(home)) as StatusReport;
    // Reported unbaselined on this call — never plain indexed with an empty baseline.
    expect(first.repos![0].state).toBe('unbaselined');
    expect(first.indexed).toBe(0);
    expect(first.unbaselined).toBe(1);
    expect(first.consultable).toBe(1); // consultable, just labeled
    expect(first.adopted).toEqual(['a']); // baseline adopted for the next call
    expect(first.note).toMatch(/unbaselined/i);

    // Drift the index; the adopted baseline now makes the drift detectable.
    writeFingerprint(peer, 'h2');
    const second = (await handleFederationStatus(home)) as StatusReport;
    expect(second.repos![0].state).toBe('stale');
    expect(second.adopted).toEqual([]); // already baselined
  });

  it('degrades a corrupt registry to a registry-unreadable conclusion rather than throwing', async () => {
    mkdirSync(join(home, '.openlore'), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not json');

    // Resolves (never rejects/throws) to the conclusion-shaped result.
    await expect(handleFederationStatus(home)).resolves.toMatchObject({
      code: 'registry-unreadable',
    });
    const result = (await handleFederationStatus(home)) as StatusReport;
    expect(result.message).toMatch(/unreadable/i);
    expect(result.note).toBeUndefined(); // conclusion shape, not the normal report
  });

  it('reports a normal indexed repo unchanged (no unbaselined regression)', async () => {
    const peer = makePeer('a', 'h'); // has an index at registration
    addRepo(home, peer, { name: 'a' });
    const report = (await handleFederationStatus(home)) as StatusReport;
    expect(report.repos![0].state).toBe('indexed');
    expect(report.indexed).toBe(1);
    expect(report.unbaselined).toBe(0);
    expect(report.adopted).toEqual([]);
  });
});

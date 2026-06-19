/**
 * Federation registry unit tests (change: add-multi-repo-federation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, symlinkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addRepo,
  removeRepo,
  listRepos,
  loadRegistry,
  evaluateRepoState,
  federationManifestPath,
} from './registry.js';
import { OPENLORE_ANALYSIS_REL_PATH } from '../../constants.js';

let home: string;
const peers: string[] = [];

function makePeer(name: string, fingerprint?: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fed-peer-${name}-`));
  peers.push(dir);
  if (fingerprint !== undefined) writeFingerprint(dir, fingerprint);
  return dir;
}

function writeFingerprint(dir: string, hash: string): void {
  const adir = join(dir, OPENLORE_ANALYSIS_REL_PATH);
  mkdirSync(adir, { recursive: true });
  writeFileSync(join(adir, 'fingerprint.json'), JSON.stringify({ hash, computedAt: '2026-06-19T00:00:00.000Z', fileCount: 1 }));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fed-home-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  for (const p of peers.splice(0)) rmSync(p, { recursive: true, force: true });
});

describe('federation registry', () => {
  it('starts empty when no manifest exists', () => {
    expect(listRepos(home)).toEqual([]);
    expect(loadRegistry(home).schemaVersion).toBe(1);
  });

  it('adds a repo, persists the manifest, and captures its fingerprint', () => {
    const peer = makePeer('a', 'hash-a');
    const { entry } = addRepo(home, peer, { now: '2026-06-19T00:00:00.000Z' });
    expect(entry.name).toMatch(/^fed-peer-a-/); // basename-derived
    expect(entry.fingerprint).toBe('hash-a');
    expect(existsSync(federationManifestPath(home))).toBe(true);
    expect(listRepos(home)).toHaveLength(1);
  });

  it('uses an explicit --name and rejects the home repo', () => {
    const peer = makePeer('a', 'h');
    const { entry } = addRepo(home, peer, { name: 'svc-a' });
    expect(entry.name).toBe('svc-a');
    expect(() => addRepo(home, home)).toThrow(/home repo/i);
  });

  it('de-duplicates by path (refresh) rather than appending', () => {
    const peer = makePeer('a', 'h1');
    addRepo(home, peer, { name: 'a' });
    writeFingerprint(peer, 'h2');
    addRepo(home, peer, { name: 'a' });
    const repos = listRepos(home);
    expect(repos).toHaveLength(1);
    expect(repos[0].fingerprint).toBe('h2');
  });

  it('rejects a name collision on a different path', () => {
    const p1 = makePeer('a', 'h');
    const p2 = makePeer('b', 'h');
    addRepo(home, p1, { name: 'dup' });
    expect(() => addRepo(home, p2, { name: 'dup' })).toThrow(/already used/i);
  });

  it('removes by name and by path', () => {
    const p1 = makePeer('a', 'h');
    const p2 = makePeer('b', 'h');
    addRepo(home, p1, { name: 'a' });
    addRepo(home, p2, { name: 'b' });
    expect(removeRepo(home, 'a')).toBe(true);
    expect(removeRepo(home, p2)).toBe(true);
    expect(listRepos(home)).toHaveLength(0);
    expect(removeRepo(home, 'nope')).toBe(false);
  });

  it('classifies index state: indexed / stale / unindexed / missing', () => {
    const indexed = makePeer('a', 'h');
    const stale = makePeer('b', 'h');
    const unindexed = makePeer('c'); // no fingerprint
    addRepo(home, indexed, { name: 'indexed' });
    addRepo(home, stale, { name: 'stale' });
    addRepo(home, unindexed, { name: 'unindexed' });
    writeFingerprint(stale, 'h-changed'); // fingerprint drifts after registration

    const byName = Object.fromEntries(listRepos(home).map(r => [r.name, r]));
    expect(evaluateRepoState(byName['indexed'])).toBe('indexed');
    expect(evaluateRepoState(byName['stale'])).toBe('stale');
    expect(evaluateRepoState(byName['unindexed'])).toBe('unindexed');

    rmSync(indexed, { recursive: true, force: true });
    expect(evaluateRepoState(byName['indexed'])).toBe('missing');
  });

  // Regression: path identity must be symlink-canonical. The CLI passes
  // `process.cwd()` as the home dir, which the OS already symlink-resolves, but a
  // user-supplied repo path is only `resolve()`d. On a system where the working
  // tree is behind a symlink (macOS /tmp → /private/tmp, a symlinked checkout) a
  // plain string compare fails to match the same directory — so the home-repo
  // self-add guard and the path de-dup silently broke. canonicalize() fixes it.
  it('canonicalizes symlinked paths: rejects the home repo and de-dups across spellings', () => {
    const realHome = realpathSync(home);
    const linkRoot = mkdtempSync(join(tmpdir(), 'fed-link-'));
    peers.push(linkRoot);
    // A symlink whose target is the (real) home repo — a different spelling of it.
    const homeLink = join(linkRoot, 'home-alias');
    symlinkSync(realHome, homeLink);
    // Adding the home repo via its symlinked spelling must still be rejected.
    expect(() => addRepo(realHome, homeLink)).toThrow(/home repo/i);

    // A real peer, then the same peer via a symlinked spelling → refresh, not append.
    const peer = makePeer('a', 'h');
    const peerLink = join(linkRoot, 'peer-alias');
    symlinkSync(realpathSync(peer), peerLink);
    addRepo(realHome, peer, { name: 'a' });
    addRepo(realHome, peerLink, { name: 'a' });
    expect(listRepos(realHome)).toHaveLength(1);
    // remove via yet another spelling (the symlink) still matches.
    expect(removeRepo(realHome, peerLink)).toBe(true);
    expect(listRepos(realHome)).toHaveLength(0);
  });

  it('throws on a corrupt manifest rather than silently degrading', () => {
    mkdirSync(join(home, '.openlore'), { recursive: true });
    writeFileSync(federationManifestPath(home), '{ not json');
    expect(() => loadRegistry(home)).toThrow(/not valid JSON/i);
  });
});

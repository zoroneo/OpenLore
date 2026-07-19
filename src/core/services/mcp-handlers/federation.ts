/**
 * MCP handler: federation_status — report the federation registry and the live
 * index state of each registered repo. Read-only, conclusion-shaped. Registered
 * only behind the opt-in `federation` preset (change: add-multi-repo-federation).
 */

import { basename } from 'node:path';
import { validateDirectory } from './utils.js';
import {
  listRepos,
  evaluateRepoState,
  readRepoFingerprint,
  adoptEmptyFingerprints,
  federationManifestPath,
} from '../../federation/registry.js';

export async function handleFederationStatus(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);

  // A corrupt/malformed `.openlore/federation.json` makes listRepos (loadRegistry)
  // throw. Degrade it to a conclusion-shaped result rather than propagating a raw
  // exception to the transport — mirroring the sibling `spec_store_status`'s
  // `registry-unreadable` finding.
  let repos;
  try {
    repos = listRepos(absDir);
  } catch (err) {
    return {
      homeRepo: basename(absDir),
      code: 'registry-unreadable',
      message: `The federation registry is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      remediation: `Fix or delete ${federationManifestPath(absDir)} (expected shape: { "schemaVersion", "repos": [] }), then re-run.`,
    };
  }

  const entries = repos.map(entry => {
    // Classified before adoption, so a pre-analyze registration is disclosed as
    // `unbaselined` on this call even though its baseline is adopted for the next.
    const state = evaluateRepoState(entry);
    return {
      name: entry.name,
      path: entry.path,
      state,
      registeredFingerprint: entry.fingerprint || null,
      liveFingerprint: readRepoFingerprint(entry.path),
      lastBuilt: entry.lastBuilt,
    };
  });

  // Adopt a baseline for any empty-fingerprint entry that now has an index, so the
  // next status check can detect drift as `stale`. Best-effort — a read-only
  // registry is harmless and the state above is still reported honestly.
  const adopted = adoptEmptyFingerprints(absDir);

  const indexed = entries.filter(e => e.state === 'indexed').length;
  const unbaselined = entries.filter(e => e.state === 'unbaselined').length;
  const consultable = indexed + unbaselined;

  const adoptedNote = adopted.length > 0
    ? ` ${adopted.length} of these had their fingerprint baseline adopted this call (${adopted.join(', ')}); subsequent drift will now report as stale.`
    : '';
  const unbaselinedNote = unbaselined > 0
    ? ` ${unbaselined} ${unbaselined === 1 ? 'is' : 'are'} unbaselined (index present but no fingerprint baseline yet — staleness not yet assessable).`
    : '';

  return {
    homeRepo: basename(absDir),
    registered: entries.length,
    indexed,
    unbaselined,
    consultable,
    adopted,
    repos: entries,
    note: entries.length === 0
      ? 'No repos registered. Add one with `openlore federation add <path>`. Federation scope on analyze_impact/find_dead_code/select_tests/find_path is a no-op until a repo is registered.'
      : `Federation is an index-of-indexes: each repo keeps its own .openlore index; queries load them lazily. ${consultable}/${entries.length} repos are currently consultable.${unbaselinedNote}${adoptedNote}`,
  };
}

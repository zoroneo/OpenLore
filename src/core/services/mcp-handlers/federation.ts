/**
 * MCP handler: federation_status — report the federation registry and the live
 * index state of each registered repo. Read-only, conclusion-shaped. Registered
 * only behind the opt-in `federation` preset (change: add-multi-repo-federation).
 */

import { validateDirectory } from './utils.js';
import { listRepos, evaluateRepoState, readRepoFingerprint } from '../../federation/registry.js';

export async function handleFederationStatus(directory: string): Promise<unknown> {
  const absDir = await validateDirectory(directory);
  const repos = listRepos(absDir);
  const entries = repos.map(entry => {
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
  const indexed = entries.filter(e => e.state === 'indexed').length;
  return {
    homeRepo: absDir,
    registered: entries.length,
    indexed,
    repos: entries,
    note: entries.length === 0
      ? 'No repos registered. Add one with `openlore federation add <path>`. Federation scope on analyze_impact/find_dead_code/select_tests/find_path is a no-op until a repo is registered.'
      : `Federation is an index-of-indexes: each repo keeps its own .openlore index; queries load them lazily. ${indexed}/${entries.length} repos are currently indexed and consultable.`,
  };
}

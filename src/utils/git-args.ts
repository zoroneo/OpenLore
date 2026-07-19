/**
 * One home for git's path-output quoting discipline.
 *
 * Git's default `core.quotepath=true` renders any path containing bytes above
 * 0x80 as a double-quoted, octal-escaped C string in `--name-only` /
 * `--name-status` / `--numstat` output — `src/café.ts` comes back as
 * `"src/caf\303\251.ts"`. Every parser that splits those lines into repo-relative
 * paths and joins them against the analyzer's path set then silently drops the
 * file: no error, no boundary disclosure, just results quietly smaller than the
 * repo. Provenance, change-coupling, drift/changed-files, and everything joined
 * on them (blast radius, coverage gaps, briefing_since, the decisions gate)
 * inherit the hole.
 *
 * `-c core.quotepath=false` makes git emit the literal UTF-8 path instead. It
 * changes only the escaping, never the record structure, and is a no-op for
 * ASCII-only paths (byte-identical output), so it is uniformly safe to prefix at
 * every spawn that parses a path list from stdout. `rev-parse` / `merge-base`
 * sites emit no paths and do not need it.
 *
 * Usage: `execFileAsync('git', gitPathArgs('diff', '--name-status', ref), opts)`.
 * A guard test (`git-args.guard.test.ts`) fails CI if a `git` spawn carrying
 * `--name-only` / `--name-status` / `--numstat` skips this helper.
 */

/** The leading `git` argv that disables path quoting in path-list output. */
export const GIT_QUOTEPATH_OFF = ['-c', 'core.quotepath=false'] as const;

/**
 * Prefix `git` argv with the quotepath-off discipline.
 *
 * @param args the git subcommand and its arguments (e.g. `'log', '--name-only'`)
 * @returns argv with `-c core.quotepath=false` prepended
 */
export function gitPathArgs(...args: string[]): string[] {
  return [...GIT_QUOTEPATH_OFF, ...args];
}

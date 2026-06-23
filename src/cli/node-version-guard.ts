/**
 * Fail-fast Node-version guard for the OpenLore CLI.
 *
 * Why this exists: OpenLore requires Node >=22.5, but OpenSpec requires only
 * >=20.19. When OpenLore runs as an OpenSpec plugin, a user on Node 20/21 can run
 * `openspec lore generate`, which spawns `openlore` under a Node OpenLore does not
 * support. `engines` in package.json is advisory at install time and does NOT
 * protect that spawn. So we check at runtime and, below the floor, write ONE
 * legible line to stderr (required + actual versions) and exit with a stable,
 * dedicated code — never a stack trace or a partial run — so the host propagates a
 * legible failure through its exit-code plumbing.
 *
 * This module is imported FIRST in src/cli/index.ts so it evaluates before
 * commander and the heavy command modules. Keep it dependency-free.
 */

/** Minimum supported Node. MUST stay in sync with package.json `engines.node`
 * (a test asserts this). */
export const MIN_NODE = { major: 22, minor: 5 } as const;

/** Stable, dedicated exit code for "unsupported Node" (documented contract). */
export const EXIT_UNSUPPORTED_NODE = 78;

export interface NodeVersionCheck {
  ok: boolean;
  message?: string;
}

/** Pure version check — no side effects, so it is unit-testable. */
export function checkNodeVersion(versionString: string = process.versions.node): NodeVersionCheck {
  const [major = 0, minor = 0] = versionString.split('.').map((p) => parseInt(p, 10));
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  if (ok) return { ok: true };
  return {
    ok: false,
    message:
      `openlore requires Node >=${MIN_NODE.major}.${MIN_NODE.minor} but is running on Node ${versionString}. ` +
      `Upgrade Node (e.g. via nvm or your package manager) and retry. ` +
      `See https://github.com/clay-good/openlore#requirements`,
  };
}

/** Side-effecting guard: writes one stderr line and exits when Node is too old. */
export function assertSupportedNode(): void {
  const result = checkNodeVersion();
  if (!result.ok) {
    process.stderr.write(`openlore: ${result.message}\n`);
    process.exit(EXIT_UNSUPPORTED_NODE);
  }
}

/**
 * Domain naming
 *
 * Single source of truth for turning a file path into a business-domain
 * name. Used by both the dependency-graph cluster naming (`suggestDomainName`)
 * and the repository-mapper domain inference (`inferDomains`) so the two never
 * diverge — a divergence that previously made Java/Kotlin projects collapse all
 * source into a reverse-DNS org root like "springframework" (issue #138).
 */

/**
 * Directory segments that should never be used as a domain name when deriving
 * one from a path. Covers generic source roots plus language build layouts
 * (Maven/Gradle `src/main/java`, Go `pkg`/`internal`) and reverse-DNS package
 * roots (`com`, `org`, `io`, …) so that Java/Kotlin/Go projects don't get
 * nonsense domains like "main", "java", "com", or "springframework".
 */
export const DOMAIN_NOISE_DIRS = new Set([
  'src', 'lib', 'app', 'apps', 'source', 'sources',
  'main', 'java', 'kotlin', 'scala', 'groovy', 'resources',
  'test', 'tests', 'spec', 'specs', '__tests__',
  'target', 'build', 'out', 'dist', 'bin', 'obj', 'gen', 'generated',
  'pkg', 'internal', 'cmd', 'node_modules', 'vendor',
  'com', 'org', 'io', 'net', 'gov', 'edu', 'co',
]);

/**
 * Canonical names for common directory roles. The first matching pattern wins;
 * an empty replacement means "fall back to the segment's own lowercased name".
 */
const DOMAIN_PATTERNS: [RegExp, string][] = [
  [/^src$/i, ''],
  [/^lib$/i, ''],
  [/^app$/i, ''],
  [/^(api|routes|endpoints?)$/i, 'api'],
  [/^(models?|entities|entity|schemas?|domain)$/i, 'domain'],
  [/^(services?)$/i, 'services'],
  [/^(controllers?|resources?)$/i, 'controllers'],
  [/^(repositor(y|ies)|repos?|dao|daos)$/i, 'repositories'],
  [/^(handlers?)$/i, 'handlers'],
  [/^(middlewares?)$/i, 'middleware'],
  [/^(utils?|helpers?|common)$/i, 'utilities'],
  [/^(components?)$/i, 'components'],
  [/^(hooks?)$/i, 'hooks'],
  [/^(config|configuration|settings)$/i, 'config'],
  [/^(dto|dtos)$/i, 'dto'],
  [/^(auth|authentication)$/i, 'authentication'],
  [/^(users?)$/i, 'users'],
  [/^(products?)$/i, 'products'],
  [/^(orders?)$/i, 'orders'],
  [/^(payments?)$/i, 'payments'],
  [/^(core)$/i, 'core'],
];

/**
 * Derive a business-domain name from a directory's path segments by walking
 * from the deepest (most specific) segment outward, skipping build-layout and
 * reverse-DNS package noise. Returns null when no meaningful segment exists
 * (e.g. a file sitting directly in a noise root), letting the caller fall back.
 *
 * `src/main/java/com/example/inventory` → `inventory`
 * `org/springframework/samples/petclinic/owner` → `owner`
 */
export function deriveDomainFromPath(dirParts: string[]): string | null {
  for (let i = dirParts.length - 1; i >= 0; i--) {
    const part = dirParts[i];
    if (!part || part === '(root)' || part.startsWith('.')) continue;
    if (DOMAIN_NOISE_DIRS.has(part.toLowerCase())) continue;
    for (const [pattern, replacement] of DOMAIN_PATTERNS) {
      if (pattern.test(part)) {
        return replacement || part.toLowerCase();
      }
    }
    return part.toLowerCase().replace(/[^a-z0-9]/g, '-');
  }
  return null;
}

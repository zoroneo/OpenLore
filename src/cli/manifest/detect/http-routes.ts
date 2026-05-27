/**
 * HTTP routes for the manifest, taken verbatim from the route inventory the
 * analyzer already produces (Express, Fastify, NestJS, FastAPI, … detectors
 * live in the analyzer). We do not add framework parsers here (spec-05 scope).
 *
 * TODO(spec-05-followup): more framework detectors in the analyzer.
 */

export interface RouteInventoryEntry {
  method: string;
  path: string;
  framework?: string;
  file?: string;
  handler?: string;
}

export interface ManifestRoute {
  method: string;
  path: string;
  /** "<file>:<handler>" when both are known, else whichever is known, else null. */
  handler: string | null;
}

export function deriveHttpRoutes(routes: RouteInventoryEntry[]): ManifestRoute[] {
  return routes
    .map((r): ManifestRoute => {
      const handler = r.file && r.handler ? `${r.file}:${r.handler}` : r.handler ?? r.file ?? null;
      return { method: r.method.toUpperCase(), path: r.path, handler };
    })
    .sort(
      (a, b) =>
        a.path.localeCompare(b.path) ||
        a.method.localeCompare(b.method) ||
        (a.handler ?? '').localeCompare(b.handler ?? '')
    );
}

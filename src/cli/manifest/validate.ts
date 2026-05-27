/**
 * `openlore manifest validate <path>` — schema-check an existing manifest.
 *
 * Validates against the canonical JSON Schema shipped with OpenLore
 * (schemas/openlore-manifest-v1.json), using the small in-repo validator
 * rather than a heavyweight dependency.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import { validateAgainstSchema, type ValidationError } from './schema-validator.js';

/** Absolute path to the vendored manifest JSON Schema (ships in the package). */
export function manifestSchemaPath(): string {
  // src/cli/manifest/validate.ts → repo root → schemas/ (same depth in dist/).
  return fileURLToPath(new URL('../../../schemas/openlore-manifest-v1.json', import.meta.url));
}

export function loadManifestSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestSchemaPath(), 'utf-8')) as Record<string, unknown>;
}

/** Validate a parsed manifest object; returns the (possibly empty) error list. */
export function validateManifest(manifest: unknown): ValidationError[] {
  return validateAgainstSchema(manifest, loadManifestSchema());
}

export function runManifestValidate(path: string): number {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    logger.error(`Cannot read manifest: ${path}`);
    return 2;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logger.error(`Invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const errors = validateManifest(parsed);
  if (errors.length === 0) {
    logger.success(`${path} is a valid OpenLore manifest (v1).`);
    return 0;
  }

  logger.error(`${path} failed schema validation (${errors.length} error(s)):`);
  for (const e of errors) logger.error(`  ${e.path || '/'}: ${e.message}`);
  return 1;
}

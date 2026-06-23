/**
 * OpenSpec **plugin** manifest — the declarative contract OpenLore publishes so
 * the OpenSpec plugin marketplace can discover, surface, gate, and install it
 * WITHOUT importing OpenLore's code.
 *
 * This is a DISTINCT artifact from the OpenLore **federation** manifest
 * (`openlore manifest …`, `.well-known/openlore.json`, schemas/openlore-manifest-v1.json),
 * which describes a repo's public symbols for cross-repo federation. The two share
 * neither schema nor command, by design — see `openlore plugin-manifest` vs
 * `openlore manifest`.
 *
 * The single source of truth is the `"openspec"` key in OpenLore's own
 * `package.json` (host Decision 3 — the package.json key form is scannable from
 * `node_modules` with zero extra files). This module reads and validates that key;
 * it never owns a second copy. A standalone `openspec.plugin.json` is supported as a
 * fallback for non-npm distribution.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAgainstSchema, type ValidationError } from '../manifest/schema-validator.js';

export const PLUGIN_MANIFEST_VERSION = 1;

export interface PluginManifestCommand {
  name: string;
  summary: string;
}

export interface PluginManifestSkill {
  dir: string;
  source: string;
}

export interface PluginManifest {
  manifestVersion: number;
  id: string;
  namespace: string;
  bin?: string;
  binArgs?: string[];
  openspecCompat: string;
  displayName?: string;
  summary?: string;
  commands?: PluginManifestCommand[];
  skills?: PluginManifestSkill[];
  workflows?: string[];
  ownsConfigKeys?: string[];
}

/** Absolute path to the vendored plugin-manifest JSON Schema (ships in the package). */
export function pluginManifestSchemaPath(): string {
  // src/cli/plugin-manifest/manifest.ts → repo root → schemas/ (same depth in dist/).
  return fileURLToPath(new URL('../../../schemas/openspec-plugin-manifest-v1.json', import.meta.url));
}

export function loadPluginManifestSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(pluginManifestSchemaPath(), 'utf-8')) as Record<string, unknown>;
}

/**
 * Read the plugin manifest from a package directory. Mirrors the host's discovery
 * order (Decision 3 / plugin-manifest spec): the `"openspec"` package.json key wins;
 * a sibling `openspec.plugin.json` is the fallback when the key is absent.
 * Returns null when neither is present.
 */
export function readPluginManifest(packageRoot: string): PluginManifest | null {
  const pkgPath = join(packageRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { openspec?: unknown };
      if (pkg.openspec && typeof pkg.openspec === 'object') {
        return pkg.openspec as PluginManifest;
      }
    } catch {
      // fall through to the standalone file
    }
  }
  const standalone = join(packageRoot, 'openspec.plugin.json');
  if (existsSync(standalone)) {
    try {
      return JSON.parse(readFileSync(standalone, 'utf-8')) as PluginManifest;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Validate a parsed plugin manifest. Combines JSON-Schema validation (types +
 * required fields, top-level passthrough preserved for forward-compat) with the
 * semantic checks the tiny schema validator cannot express:
 *   - exactly one executable form is declared (`bin` OR `binArgs`),
 *   - `namespace` is a single lowercase token (host reserves it as a top-level verb).
 * Returns the (possibly empty) error list, same shape as the federation validator.
 */
export function validatePluginManifest(manifest: unknown): ValidationError[] {
  const errors = validateAgainstSchema(manifest, loadPluginManifestSchema());

  if (manifest && typeof manifest === 'object') {
    const m = manifest as Record<string, unknown>;

    const hasBin = typeof m.bin === 'string' && m.bin.length > 0;
    const hasBinArgs = Array.isArray(m.binArgs) && m.binArgs.length > 0;
    if (!hasBin && !hasBinArgs) {
      errors.push({ path: '/bin', message: 'an executable is required: declare "bin" or "binArgs"' });
    }

    if (typeof m.namespace === 'string' && !/^[a-z][a-z0-9-]*$/.test(m.namespace)) {
      errors.push({
        path: '/namespace',
        message: 'namespace must be a single lowercase token (a-z, 0-9, hyphen)',
      });
    }
  }

  return errors;
}

/** Serialize a manifest to the exact bytes printed to stdout (machine-readable). */
export function serializePluginManifest(manifest: PluginManifest): string {
  return JSON.stringify(manifest, null, 2) + '\n';
}

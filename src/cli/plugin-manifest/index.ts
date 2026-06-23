/**
 * `openlore plugin-manifest <emit|validate>` — inspect/validate the OpenSpec
 * **plugin** manifest OpenLore publishes (the `"openspec"` key in package.json).
 *
 * Deliberately named `plugin-manifest`, NOT `manifest`: `openlore manifest` is the
 * unrelated federation manifest (`.well-known/openlore.json`). Keeping the names
 * distinct means the two artifacts never collide in help, docs, or a user's mental
 * model. Discovery itself needs no command — OpenSpec reads the static package.json
 * key — so this command exists only for CI validation and non-npm distribution.
 */

import { Command } from 'commander';
import { fileURLToPath } from 'node:url';
import { logger } from '../../utils/logger.js';
import {
  readPluginManifest,
  validatePluginManifest,
  serializePluginManifest,
} from './manifest.js';

/** OpenLore's own package root (where its package.json + the "openspec" key live). */
export function ownPackageRoot(): string {
  // src/cli/plugin-manifest/index.ts → repo root (same depth in dist/).
  return fileURLToPath(new URL('../../../', import.meta.url));
}

/**
 * Print the plugin manifest from `packageRoot` and return the process exit code.
 * Returns 2 when no manifest is found, 0 otherwise. In `--json` mode stdout
 * carries ONLY the manifest. Mirrors the federation `runManifestValidate`
 * return-code pattern so the exit-code contract is unit-testable without spawning.
 */
export function runPluginManifestEmit(packageRoot: string, asJson: boolean): number {
  const manifest = readPluginManifest(packageRoot);
  if (!manifest) {
    logger.error('No OpenSpec plugin manifest found (expected an "openspec" key in package.json).');
    return 2;
  }
  if (asJson) {
    process.stdout.write(serializePluginManifest(manifest));
    return 0;
  }
  logger.info('id', manifest.id);
  logger.info('namespace', manifest.namespace);
  logger.info('bin', manifest.bin ?? (manifest.binArgs ?? []).join(' '));
  logger.info('openspecCompat', manifest.openspecCompat);
  logger.info('commands', (manifest.commands ?? []).map((c) => c.name).join(', ') || '(none)');
  logger.info('skills', (manifest.skills ?? []).map((s) => s.dir).join(', ') || '(none)');
  logger.info('ownsConfigKeys', (manifest.ownsConfigKeys ?? []).join(', ') || '(none)');
  return 0;
}

/**
 * Validate the plugin manifest in `packageRoot` and return the process exit code:
 * 0 valid, 1 schema/semantic failure, 2 no manifest found.
 */
export function runPluginManifestValidate(packageRoot: string): number {
  const manifest = readPluginManifest(packageRoot);
  if (!manifest) {
    logger.error(`No OpenSpec plugin manifest found in ${packageRoot} ("openspec" key or openspec.plugin.json).`);
    return 2;
  }
  const errors = validatePluginManifest(manifest);
  if (errors.length === 0) {
    logger.success('OpenSpec plugin manifest is valid (v1).');
    return 0;
  }
  logger.error(`OpenSpec plugin manifest failed validation (${errors.length} error(s)):`);
  for (const e of errors) logger.error(`  ${e.path || '/'}: ${e.message}`);
  return 1;
}

const emitSubcommand = new Command('emit')
  .description('Print the OpenSpec plugin manifest OpenLore publishes (the package.json "openspec" key).')
  .option('--json', 'Emit the manifest as JSON on stdout (machine-readable)', false)
  .action((opts: { json?: boolean }) => {
    process.exit(runPluginManifestEmit(ownPackageRoot(), opts.json ?? false));
  });

const validateSubcommand = new Command('validate')
  .description('Validate the OpenSpec plugin manifest against the vendored schema and semantic rules.')
  .argument('[packageRoot]', 'Package directory to validate (default: OpenLore itself)')
  .action((packageRoot: string | undefined) => {
    process.exit(runPluginManifestValidate(packageRoot ?? ownPackageRoot()));
  });

export const pluginManifestCommand = new Command('plugin-manifest')
  .description('Inspect or validate the OpenSpec plugin manifest (distinct from the federation `manifest`).')
  .addCommand(emitSubcommand)
  .addCommand(validateSubcommand);

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
function ownPackageRoot(): string {
  // src/cli/plugin-manifest/index.ts → repo root (same depth in dist/).
  return fileURLToPath(new URL('../../../', import.meta.url));
}

const emitSubcommand = new Command('emit')
  .description('Print the OpenSpec plugin manifest OpenLore publishes (the package.json "openspec" key).')
  .option('--json', 'Emit the manifest as JSON on stdout (machine-readable)', false)
  .action((opts: { json?: boolean }) => {
    const manifest = readPluginManifest(ownPackageRoot());
    if (!manifest) {
      logger.error('No OpenSpec plugin manifest found (expected an "openspec" key in package.json).');
      process.exit(2);
    }
    if (opts.json) {
      // --json: stdout carries ONLY the manifest, nothing else.
      process.stdout.write(serializePluginManifest(manifest));
      return;
    }
    logger.info('id', manifest.id);
    logger.info('namespace', manifest.namespace);
    logger.info('bin', manifest.bin ?? (manifest.binArgs ?? []).join(' '));
    logger.info('openspecCompat', manifest.openspecCompat);
    logger.info('commands', (manifest.commands ?? []).map((c) => c.name).join(', ') || '(none)');
    logger.info('skills', (manifest.skills ?? []).map((s) => s.dir).join(', ') || '(none)');
    logger.info('ownsConfigKeys', (manifest.ownsConfigKeys ?? []).join(', ') || '(none)');
  });

const validateSubcommand = new Command('validate')
  .description('Validate the OpenSpec plugin manifest against the vendored schema and semantic rules.')
  .argument('[packageRoot]', 'Package directory to validate (default: OpenLore itself)')
  .action((packageRoot: string | undefined) => {
    const root = packageRoot ?? ownPackageRoot();
    const manifest = readPluginManifest(root);
    if (!manifest) {
      logger.error(`No OpenSpec plugin manifest found in ${root} ("openspec" key or openspec.plugin.json).`);
      process.exit(2);
    }
    const errors = validatePluginManifest(manifest);
    if (errors.length === 0) {
      logger.success('OpenSpec plugin manifest is valid (v1).');
      process.exit(0);
    }
    logger.error(`OpenSpec plugin manifest failed validation (${errors.length} error(s)):`);
    for (const e of errors) logger.error(`  ${e.path || '/'}: ${e.message}`);
    process.exit(1);
  });

export const pluginManifestCommand = new Command('plugin-manifest')
  .description('Inspect or validate the OpenSpec plugin manifest (distinct from the federation `manifest`).')
  .addCommand(emitSubcommand)
  .addCommand(validateSubcommand);

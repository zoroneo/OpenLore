/**
 * `openlore embed` — enable a semantic embedding provider in one command.
 *
 * The headline use is `openlore embed --local`: it turns on a zero-config,
 * on-device embedder (no endpoint, no API key) and rebuilds the semantic index.
 * The model is lazily downloaded and cached on first use. Keyword (BM25) search
 * remains the first-class default; this is purely an opt-in ranking upgrade.
 */

import { Command } from 'commander';
import { logger } from '../../utils/logger.js';
import { readOpenLoreConfig, writeOpenLoreConfig } from '../../core/services/config-manager.js';
import { DEFAULT_LOCAL_MODEL } from '../../core/analyzer/local-embedding-service.js';

interface EmbedOptions {
  local?: boolean;
  model?: string;
}

export const embedCommand = new Command('embed')
  .description('Enable semantic embeddings and (re)build the semantic index')
  .option('--local', 'Use the on-device local embedder — no endpoint, no API key', false)
  .option('--model <id>', 'Override the local embedding model (advanced; default is a pinned small model)')
  .addHelpText(
    'after',
    `
Examples:
  $ openlore embed --local           Turn on on-device semantic search and rebuild the index

Notes:
  • The model is downloaded and cached under ~/.openlore/models on first use
    (one-time, ~23 MB) — no API key, no endpoint, CPU only.
  • Keyword (BM25) search is the first-class default and keeps working without this.
  • For a remote OpenAI-compatible endpoint instead, set EMBED_BASE_URL/EMBED_MODEL
    or an "embedding" block in .openlore/config.json, then run "openlore analyze".
`
  )
  .action(async (options: EmbedOptions) => {
    const rootPath = process.cwd();

    if (!options.local) {
      logger.error('Specify a provider. The supported one-command option is: openlore embed --local');
      process.exitCode = 1;
      return;
    }

    const cfg = await readOpenLoreConfig(rootPath);
    if (!cfg) {
      logger.error('No openlore configuration found. Run "openlore init" first.');
      process.exitCode = 1;
      return;
    }

    const model = options.model || DEFAULT_LOCAL_MODEL;
    // Switch the provider to local. Replacing the block (rather than merging the
    // remote endpoint) is intentional: --local picks the on-device provider.
    cfg.embedding = { provider: 'local', model };
    await writeOpenLoreConfig(rootPath, cfg);
    logger.success(`Embedding provider set to local (${model}).`);
    logger.info('Model', `Cached under ~/.openlore/models on first use — no API key, no endpoint, CPU only.`);

    // Rebuild the index with the local embedder. --force guarantees a clean full
    // re-embed when switching from a keyword or remote index (vectors from a
    // different model must not be reused).
    logger.discovery('Building the local-semantic index (downloads the model on first run)…');
    const { analyzeCommand } = await import('./analyze.js');
    await analyzeCommand.parseAsync(['--force'], { from: 'user' });
  });

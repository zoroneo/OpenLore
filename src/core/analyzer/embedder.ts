/**
 * Embedder resolution — the single provider-selection path shared by every
 * consumer (analyze, watch, orient, search_code, search_specs, generate, view).
 *
 * Kept in its own module (separate from `embedding-service.ts`) so the remote
 * `EmbeddingService` can be unit-mocked without also having to stub this shared
 * logic: `resolveEmbedder` calls the real (or mocked) `EmbeddingService`
 * internally, so a mock of `fromEnv`/`fromConfig` continues to drive it.
 */

import type { Embedder } from './embedding-service.js';
import type { OpenLoreConfig } from '../../types/index.js';

/** Honest, served retrieval mode — first-class keyword default or a semantic upgrade. */
export type RetrievalMode = 'keyword' | 'local-semantic' | 'remote-semantic';

/**
 * Resolve the active embedder from environment and config, in priority order:
 *   1. `EMBED_*` environment variables (remote OpenAI-compatible endpoint)
 *   2. config `embedding.provider: 'local'` → on-device {@link LocalEmbeddingService}
 *   3. config remote endpoint (`embedding.baseUrl` + `embedding.model`)
 * Returns null when nothing is configured — the first-class keyword (BM25)
 * default, never an error. Sharing one resolver means the configured provider is
 * honoured identically at build time and query time.
 *
 * Dependencies are imported dynamically (matching the rest of the codebase) so
 * the remote `EmbeddingService` stays unit-mockable via `vi.doMock`.
 */
export async function resolveEmbedder(cfg?: OpenLoreConfig | null): Promise<Embedder | null> {
  const { EmbeddingService } = await import('./embedding-service.js');
  try {
    return EmbeddingService.fromEnv();
  } catch {
    /* no env config — fall through to file config */
  }
  if (cfg?.embedding?.provider === 'local') {
    const { LocalEmbeddingService } = await import('./local-embedding-service.js');
    return LocalEmbeddingService.fromConfig(cfg.embedding);
  }
  // Remote (or unconfigured): fromConfig returns null when no remote endpoint
  // is set, which is the first-class keyword default.
  return cfg ? EmbeddingService.fromConfig(cfg) : null;
}

/**
 * The retrieval mode implied by the active embedder: `keyword` when there is no
 * embedder, otherwise `local-semantic` / `remote-semantic` per its origin
 * (local-provider model names are prefixed `local:`). Used for honest, low-noise
 * mode reporting in query handlers and CLI summaries.
 */
export function embedderMode(embedSvc: Embedder | null | undefined): RetrievalMode {
  if (!embedSvc) return 'keyword';
  return String(embedSvc.modelName ?? '').startsWith('local:') ? 'local-semantic' : 'remote-semantic';
}

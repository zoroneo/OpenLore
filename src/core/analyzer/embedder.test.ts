import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEmbedder, embedderMode } from './embedder.js';
import { LocalEmbeddingService, DEFAULT_LOCAL_MODEL } from './local-embedding-service.js';
import { EmbeddingService } from './embedding-service.js';
import type { OpenLoreConfig } from '../../types/index.js';

const cfg = (embedding?: OpenLoreConfig['embedding']): OpenLoreConfig =>
  ({ version: '1.0', embedding } as unknown as OpenLoreConfig);

describe('resolveEmbedder — provider selection (lexical default, semantic opt-in)', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    delete process.env.EMBED_BASE_URL;
    delete process.env.EMBED_MODEL;
    delete process.env.EMBED_API_KEY;
  });
  afterEach(() => {
    process.env = { ...saved };
  });

  it('returns null (first-class keyword default) when nothing is configured', async () => {
    expect(await resolveEmbedder(null)).toBeNull();
    expect(await resolveEmbedder(cfg(undefined))).toBeNull();
  });

  it('uses the local provider when embedding.provider is "local"', async () => {
    const e = await resolveEmbedder(cfg({ provider: 'local' }));
    expect(e).toBeInstanceOf(LocalEmbeddingService);
    expect(e?.modelName).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
  });

  it('honours a local model override', async () => {
    const e = await resolveEmbedder(cfg({ provider: 'local', model: 'Xenova/bge-small-en-v1.5' }));
    expect(e?.modelName).toBe('local:Xenova/bge-small-en-v1.5');
  });

  it('uses the remote endpoint when baseUrl + model are set (no provider)', async () => {
    const e = await resolveEmbedder(cfg({ baseUrl: 'http://localhost:1234/v1', model: 'nomic-embed-text' }));
    expect(e).toBeInstanceOf(EmbeddingService);
    expect(e?.modelName).toBe('nomic-embed-text');
  });

  it('prefers EMBED_* env (remote) over a config local provider', async () => {
    process.env.EMBED_BASE_URL = 'http://localhost:9999/v1';
    process.env.EMBED_MODEL = 'env-model';
    const e = await resolveEmbedder(cfg({ provider: 'local' }));
    expect(e).toBeInstanceOf(EmbeddingService);
    expect(e?.modelName).toBe('env-model');
  });
});

describe('embedderMode — honest mode reporting', () => {
  it('maps no embedder to the keyword default', () => {
    expect(embedderMode(null)).toBe('keyword');
    expect(embedderMode(undefined)).toBe('keyword');
  });

  it('maps a local-prefixed model to local-semantic', () => {
    expect(embedderMode({ modelName: 'local:Xenova/all-MiniLM-L6-v2', embed: async () => [] })).toBe('local-semantic');
  });

  it('maps a plain model name to remote-semantic', () => {
    expect(embedderMode({ modelName: 'text-embedding-3-small', embed: async () => [] })).toBe('remote-semantic');
  });
});

describe('LocalEmbeddingService', () => {
  it('records a local: prefixed model name for sidecar mode detection', () => {
    expect(new LocalEmbeddingService().modelName).toBe(`local:${DEFAULT_LOCAL_MODEL}`);
    expect(LocalEmbeddingService.fromConfig({ provider: 'local', model: 'm' }).modelName).toBe('local:m');
  });

  it('returns [] for an empty input without loading the model', async () => {
    expect(await new LocalEmbeddingService().embed([])).toEqual([]);
  });
});

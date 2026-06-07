/**
 * openlore Pi extension — src/pi/extension.ts
 *
 * Compiled to dist/pi/extension.js and declared in package.json "pi" field so
 * `pi install npm:openlore` drops it into the Pi extension registry automatically.
 *
 * Two halves:
 *   C — context injection (before_agent_start): model starts grounded with the
 *       architecture digest + spec index + task-grounded orient call, so weak
 *       tool-callers benefit even without calling a tool.
 *   B — native tools (registerTool): navigation surface for on-demand structural
 *       queries, each round-tripping to the warm daemon via fetch.
 *
 * Uses ctx.mode (0.78.1+): full injection in tui/rpc (interactive), none in
 * json/print (one-shot). rpc = headless interactive over stdin/stdout (IDE,
 * custom UI) — same injection needs as tui.
 *
 * Config onboarding: runs on first session when .openlore/config.json is absent;
 * also available anytime via the openlore_configure tool.
 */

import type {
  AgentToolResult,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type, type TObject, type TSchema } from 'typebox';

import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Config types & helpers ────────────────────────────────────────────────────

interface OpenLoreConfig {
  version: string;
  projectType: string;
  openspecPath: string;
  analysis: { maxFiles: number; includePatterns: string[]; excludePatterns: string[] };
  generation: {
    provider?: string;
    model?: string;
    openaiCompatBaseUrl?: string;
    skipSslVerify?: boolean;
  };
  embedding?: {
    baseUrl: string;
    model: string;
    apiKey?: string;
    skipSslVerify?: boolean;
  };
  createdAt: string;
  lastRun: string | null;
}

const OPENLORE_DIR = '.openlore';

async function readConfig(cwd: string): Promise<OpenLoreConfig | null> {
  try {
    return JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'config.json'), 'utf-8')) as OpenLoreConfig;
  } catch { return null; }
}

async function writeConfig(cwd: string, config: OpenLoreConfig): Promise<void> {
  await mkdir(join(cwd, OPENLORE_DIR), { recursive: true });
  await writeFile(join(cwd, OPENLORE_DIR, 'config.json'), JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

const PROVIDERS = [
  'anthropic', 'openai', 'openai-compat', 'gemini',
  'copilot', 'claude-code', 'gemini-cli', 'mistral-vibe', 'cursor-agent',
];

const PROVIDER_MODEL_DEFAULTS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  'openai-compat': '',
  gemini: 'gemini-2.0-flash',
  copilot: 'gpt-4o',
  'claude-code': 'claude-sonnet-4-6',
  'gemini-cli': 'gemini-2.0-flash',
  'mistral-vibe': 'codestral-latest',
  'cursor-agent': '',
};

const SYSTEM_AUTH_PROVIDERS = new Set(['copilot', 'claude-code', 'gemini-cli', 'mistral-vibe', 'cursor-agent']);

async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[] | null> {
  try {
    const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const res = await fetch(`${base}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    return data.data?.map((m) => m.id).sort() ?? null;
  } catch { return null; }
}

// ── Config wizard ─────────────────────────────────────────────────────────────

async function runConfigWizard(ctx: ExtensionContext, existing?: OpenLoreConfig | null): Promise<void> {
  const { ui } = ctx;

  // ui.select / ui.input / ui.confirm: undefined = cancelled, '' = empty.
  // For edits, always fall back to existing values so partial navigation never destroys data.

  // Put existing provider first so select starts on the current value.
  const existingProvider = existing?.generation?.provider;
  const providerList = existingProvider
    ? [existingProvider, ...PROVIDERS.filter((p) => p !== existingProvider)]
    : PROVIDERS;
  const provider = await ui.select('LLM provider', providerList) ?? providerList[0];

  let baseUrl: string | undefined = existing?.generation?.openaiCompatBaseUrl;
  let genSkipSsl = existing?.generation?.skipSslVerify ?? false;
  let apiKey: string | undefined;

  if (provider === 'openai-compat') {
    const rawUrl = await ui.input('Base URL', baseUrl ?? 'http://localhost:11434');
    baseUrl = rawUrl || baseUrl || '';
    genSkipSsl = await ui.confirm('Skip SSL verification?', 'Required for local servers with self-signed certificates');
  }

  if (!SYSTEM_AUTH_PROVIDERS.has(provider)) {
    const key = await ui.input('API key', '(blank to skip / keep existing)');
    // Empty or placeholder means "keep existing" — we don't store keys so just omit.
    apiKey = key && key !== '(blank to skip / keep existing)' ? key : undefined;
  }

  let model: string;
  const apiBase = provider === 'openai' ? 'https://api.openai.com' : (baseUrl ?? '');
  const models = apiBase ? await fetchModels(apiBase, apiKey) : null;

  if (models && models.length > 0) {
    model = await ui.select('Model', models) ?? models[0];
  } else {
    const existingModel = existing?.generation?.model ?? PROVIDER_MODEL_DEFAULTS[provider] ?? '';
    model = (await ui.input('Model', existingModel)) || existingModel;
  }

  const maxFilesRaw = await ui.input('Max files to analyze', String(existing?.analysis?.maxFiles ?? 500));
  const maxFiles = parseInt(maxFilesRaw ?? '500', 10) || 500;

  // Embedding: if already configured, ask whether to change it — declining preserves existing.
  let embedding: OpenLoreConfig['embedding'] | undefined = existing?.embedding;
  const embedPrompt = existing?.embedding
    ? `Change embedding? (current: ${existing.embedding.baseUrl})`
    : 'Configure a custom embedding endpoint?';
  const embedMessage = existing?.embedding
    ? 'Select No to keep the current embedding configuration unchanged.'
    : 'Optional — enables semantic search with a local embedding model (e.g. Ollama)';
  const changeEmbed = await ui.confirm(embedPrompt, embedMessage);
  if (changeEmbed) {
    const embedUrl = (await ui.input('Embedding base URL', existing?.embedding?.baseUrl ?? '')) ?? '';
    const embedSsl = await ui.confirm('Skip SSL verification for embedding?', 'Required for self-signed certificates');
    const embedModels = embedUrl ? await fetchModels(embedUrl) : null;
    let embedModel: string;
    if (embedModels && embedModels.length > 0) {
      embedModel = await ui.select('Embedding model', embedModels) ?? embedModels[0];
    } else {
      const existingEmbedModel = existing?.embedding?.model ?? '';
      embedModel = (await ui.input('Embedding model', existingEmbedModel)) || existingEmbedModel;
    }
    const embedKey = await ui.input('Embedding API key', '(blank if not needed)') ?? '';
    embedding = {
      baseUrl: embedUrl,
      model: embedModel,
      ...(embedKey && embedKey !== '(blank if not needed)' ? { apiKey: embedKey } : {}),
      ...(embedSsl ? { skipSslVerify: true } : {}),
    };
  }

  const config: OpenLoreConfig = {
    version: '1.0.0',
    projectType: existing?.projectType ?? 'unknown',
    openspecPath: existing?.openspecPath ?? 'openspec',
    analysis: {
      maxFiles,
      includePatterns: existing?.analysis?.includePatterns ?? [],
      excludePatterns: existing?.analysis?.excludePatterns ?? [],
    },
    generation: {
      provider,
      model,
      ...(baseUrl ? { openaiCompatBaseUrl: baseUrl } : {}),
      ...(genSkipSsl ? { skipSslVerify: true } : {}),
    },
    ...(embedding ? { embedding } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastRun: existing?.lastRun ?? null,
  };

  await writeConfig(ctx.cwd, config);
  ui.notify('openlore configured — run `openlore analyze` to build the structural index.', 'info');
}

// ── Daemon discovery + lifecycle ──────────────────────────────────────────────

interface ServeDescriptor { port: number; pid: number; host: string; token?: string }
interface Daemon { baseUrl: string; token?: string }

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
const RESULT_MAX = 50_000;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function readDescriptor(cwd: string): Promise<ServeDescriptor | null> {
  try {
    return JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'serve.json'), 'utf-8')) as ServeDescriptor;
  } catch { return null; }
}

async function healthy(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    return ((await res.json().catch(() => null)) as { ok?: boolean } | null)?.ok === true;
  } catch { return false; }
}

async function ensureDaemon(cwd: string): Promise<Daemon | null> {
  const existing = await readDescriptor(cwd);
  if (existing && (await healthy(existing))) return { baseUrl: `http://${existing.host}:${existing.port}`, token: existing.token };
  try {
    spawn('openlore', ['serve', '--directory', cwd], { detached: true, stdio: 'ignore' }).unref();
  } catch { return null; }
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    const desc = await readDescriptor(cwd);
    if (desc && (await healthy(desc))) return { baseUrl: `http://${desc.host}:${desc.port}`, token: desc.token };
  }
  return null;
}

async function callTool(daemon: Daemon, name: string, args: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (daemon.token) headers['x-openlore-token'] = daemon.token;
  try {
    const res = await fetch(`${daemon.baseUrl}/tool/${encodeURIComponent(name)}`, {
      method: 'POST', headers, body: JSON.stringify({ directory: cwd, args }), signal,
    });
    const body = await res.json().catch(() => ({ error: `non-JSON (${res.status})` }));
    if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) { return { error: err instanceof Error ? err.message : String(err) }; }
}

// ── Context injection helpers ─────────────────────────────────────────────────

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}

async function readDigest(cwd: string): Promise<string> {
  try { return await readFile(join(cwd, OPENLORE_DIR, 'analysis', 'CODEBASE.md'), 'utf-8'); }
  catch { return ''; }
}

async function readSpecIndex(cwd: string): Promise<string> {
  try {
    const { readdir } = await import('node:fs/promises');
    const dirs = (await readdir(join(cwd, 'openspec', 'specs'), { withFileTypes: true }))
      .filter((d) => d.isDirectory()).map((d) => d.name);
    if (dirs.length === 0) return '';
    return ['## openlore spec domains', ...dirs.map((d) => `- ${d}`)].join('\n');
  } catch { return ''; }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

interface NavToolSpec { name: string; label: string; description: string; guideline: string; parameters: TObject }

const NAV_TOOLS: NavToolSpec[] = [
  {
    name: 'orient',
    label: 'openlore orient',
    description: 'START HERE on any new task. Returns relevant functions, files, spec domains, call neighbours, and insertion points in one call.',
    guideline: 'Use openlore_orient FIRST on any new task before reading files.',
    parameters: Type.Object({ task: Type.String({ description: 'Natural-language task description' }), limit: Type.Optional(Type.Number()) }),
  },
  {
    name: 'search_code',
    label: 'openlore search_code',
    description: 'Semantic + keyword search for functions by meaning or name.',
    guideline: 'Use openlore_search_code to find where a concept lives instead of grepping.',
    parameters: Type.Object({ query: Type.String(), limit: Type.Optional(Type.Number()), language: Type.Optional(Type.String()) }),
  },
  {
    name: 'get_subgraph',
    label: 'openlore get_subgraph',
    description: 'Call topology around a function (callers/callees) to a given depth.',
    guideline: 'Use openlore_get_subgraph to see blast radius before changing a function.',
    parameters: Type.Object({ functionName: Type.String(), direction: Type.Optional(StringEnum(['downstream', 'upstream', 'both'] as const)), maxDepth: Type.Optional(Type.Number()) }),
  },
  {
    name: 'trace_execution_path',
    label: 'openlore trace_execution_path',
    description: 'Find call paths from an entry function to a target function.',
    guideline: 'Use openlore_trace_execution_path to answer "how does X reach Y".',
    parameters: Type.Object({ entryFunction: Type.String(), targetFunction: Type.String(), maxDepth: Type.Optional(Type.Number()) }),
  },
  {
    name: 'analyze_impact',
    label: 'openlore analyze_impact',
    description: 'Blast radius of changing a symbol (transitive dependents).',
    guideline: 'Use openlore_analyze_impact before editing a shared/hub symbol.',
    parameters: Type.Object({ symbol: Type.String(), depth: Type.Optional(Type.Number()) }),
  },
  {
    name: 'suggest_insertion_points',
    label: 'openlore suggest_insertion_points',
    description: 'Where to add a feature — ranked file/function insertion candidates.',
    guideline: 'Use openlore_suggest_insertion_points when planning where new code goes.',
    parameters: Type.Object({ description: Type.String(), limit: Type.Optional(Type.Number()) }),
  },
  {
    name: 'get_function_skeleton',
    label: 'openlore get_function_skeleton',
    description: 'Compact skeleton of a file: signatures + control flow, noise stripped.',
    guideline: 'Use openlore_get_function_skeleton to read a file cheaply before opening it.',
    parameters: Type.Object({ filePath: Type.String() }),
  },
];

function toolResult(text: string, details: unknown = null): AgentToolResult<unknown> {
  return { content: [{ type: 'text', text }], details };
}

// ── Extension entry point ─────────────────────────────────────────────────────

export default function openlore(pi: ExtensionAPI): void {
  const daemons = new Map<string, Daemon | null>();
  const primed = new Set<string>();
  let sessionCwd = process.cwd();
  let sessionMode: ExtensionContext['mode'] = 'tui';

  async function getDaemon(cwd: string): Promise<Daemon | null> {
    if (!daemons.has(cwd)) {
      const d = await ensureDaemon(cwd);
      if (d) daemons.set(cwd, d);
      return d;
    }
    return daemons.get(cwd) ?? null;
  }

  // ── B: navigation tools ──
  for (const tool of NAV_TOOLS) {
    pi.registerTool({
      name: `openlore_${tool.name}`,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.description,
      promptGuidelines: [tool.guideline],
      parameters: tool.parameters as TSchema,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const daemon = await getDaemon(ctx.cwd);
        if (!daemon) return toolResult('openlore daemon unavailable — run `openlore analyze` then retry.');
        const result = await callTool(daemon, tool.name, params as Record<string, unknown>, ctx.cwd, signal ?? undefined);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return toolResult(truncate(text, RESULT_MAX), result);
      },
    });
  }

  // ── Config tool ──
  pi.registerTool({
    name: 'openlore_configure',
    label: 'openlore configure',
    description: 'Open the openlore configuration wizard to set provider, model, embedding, and analysis settings.',
    promptSnippet: 'Configure openlore settings (provider, model, API key, embedding).',
    promptGuidelines: ['Use openlore_configure to change the LLM provider, model, or embedding settings.'],
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      if (!ctx.hasUI) return toolResult('Config wizard requires an interactive session (tui or rpc mode).');
      const existing = await readConfig(ctx.cwd);
      await runConfigWizard(ctx, existing);
      return toolResult('Configuration saved to .openlore/config.json.');
    },
  });

  // ── /configure slash command ──
  pi.registerCommand('configure', {
    description: 'Open the openlore configuration wizard',
    async handler(_args, ctx) {
      if (!ctx.hasUI) {
        ctx.ui.notify('Config wizard requires an interactive session.', 'error');
        return;
      }
      const existing = await readConfig(ctx.cwd);
      await runConfigWizard(ctx, existing);
    },
  });

  // ── session_start: onboarding + daemon warmup ──
  pi.on('session_start', async (_event: SessionStartEvent, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    sessionMode = ctx.mode;

    if (ctx.hasUI && !(await readConfig(ctx.cwd))) {
      await runConfigWizard(ctx, null);
    }

    if (ctx.mode !== 'json' && ctx.mode !== 'print') {
      await getDaemon(ctx.cwd);
    }
  });

  // ── C: context injection on the first turn ──
  pi.on('before_agent_start', async (event: BeforeAgentStartEvent, _ctx: ExtensionContext): Promise<BeforeAgentStartEventResult | void> => {
    if (sessionMode === 'json' || sessionMode === 'print') return;
    if (primed.has(sessionCwd)) return;
    primed.add(sessionCwd);

    const blocks: string[] = [];
    const digest = await readDigest(sessionCwd);
    if (digest) blocks.push('# Codebase architecture (openlore)\n\n' + truncate(digest, 8000));
    const specIndex = await readSpecIndex(sessionCwd);
    if (specIndex) blocks.push(specIndex);

    const daemon = await getDaemon(sessionCwd);
    if (daemon && event.prompt) {
      const oriented = await callTool(daemon, 'orient', { task: event.prompt }, sessionCwd);
      if (oriented && typeof oriented === 'object' && !('error' in (oriented as object))) {
        blocks.push('# openlore orientation for this task\n\n' + truncate(JSON.stringify(oriented, null, 2), 6000));
      }
    }

    const suffix = blocks.length > 0
      ? blocks.join('\n\n')
      : '[openlore: no analysis found — run `openlore analyze` to enable structural context.]';

    return { systemPrompt: event.systemPrompt + '\n\n' + suffix };
  });
}

export const installPaths = {
  project: (cwd: string) => join(cwd, '.pi', 'extensions', 'openlore.js'),
  global: () => join(homedir(), '.pi', 'agent', 'extensions', 'openlore.js'),
};

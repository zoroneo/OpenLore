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
    const raw = JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'config.json'), 'utf-8')) as OpenLoreConfig;
    // Treat as absent if config is missing the minimum viable fields.
    if (!raw || typeof raw !== 'object' || !raw.generation?.provider) return null;
    return raw;
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

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  'openai-compat': 'OPENAI_COMPAT_API_KEY',
  copilot: 'COPILOT_API_KEY',
};

async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[] | null> {
  try {
    const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    const res = await fetch(`${base}/v1/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    return data.data?.map((m) => m.id).sort() ?? null;
  } catch { return null; }
}

// ── Config wizard ─────────────────────────────────────────────────────────────

async function configureGeneration(
  ui: ExtensionContext['ui'],
  existing?: OpenLoreConfig['generation'],
): Promise<OpenLoreConfig['generation']> {
  const existingProvider = existing?.provider;
  const providerList = existingProvider
    ? [`${existingProvider} *`, ...PROVIDERS.filter((p) => p !== existingProvider)]
    : PROVIDERS;
  const selectedProvider = await ui.select('LLM provider', providerList) ?? providerList[0];
  const provider = selectedProvider.replace(/ \*$/, '');

  let baseUrl: string | undefined = existing?.openaiCompatBaseUrl;
  let skipSslVerify = existing?.skipSslVerify ?? false;
  let apiKey: string | undefined;

  if (provider === 'openai-compat') {
    const urlTitle = baseUrl ? `Base URL (current: ${baseUrl})` : 'Base URL';
    const rawUrl = await ui.input(urlTitle, 'http://localhost:11434');
    baseUrl = rawUrl || baseUrl || '';
    skipSslVerify = await ui.confirm(
      'Skip SSL verification?',
      'Only enable for local servers with self-signed certificates (e.g. Ollama on localhost). Do NOT enable for remote/cloud endpoints.',
    );
  }

  if (!SYSTEM_AUTH_PROVIDERS.has(provider) && PROVIDER_ENV_VARS[provider]) {
    apiKey = process.env[PROVIDER_ENV_VARS[provider]];
    if (!apiKey) {
      ui.notify(`API key: set ${PROVIDER_ENV_VARS[provider]} in your shell environment`, 'warning');
    }
  }

  let model: string;
  const apiBase = provider === 'openai' ? 'https://api.openai.com' : (baseUrl ?? '');
  const models = apiBase ? await fetchModels(apiBase, apiKey) : null;

  if (models && models.length > 0) {
    const currentModel = existing?.model;
    const modelList = currentModel && models.includes(currentModel)
      ? [`${currentModel} *`, ...models.filter((m) => m !== currentModel)]
      : models;
    const selectedModel = await ui.select('Model', modelList) ?? modelList[0];
    model = selectedModel.replace(/ \*$/, '');
  } else {
    const existingModel = existing?.model ?? PROVIDER_MODEL_DEFAULTS[provider] ?? '';
    const modelTitle = existing?.model ? `Model (current: ${existing.model})` : 'Model';
    model = (await ui.input(modelTitle, PROVIDER_MODEL_DEFAULTS[provider] ?? '')) || existingModel;
  }

  return {
    provider,
    model,
    ...(baseUrl ? { openaiCompatBaseUrl: baseUrl } : {}),
    ...(skipSslVerify ? { skipSslVerify: true } : {}),
  };
}

async function configureEmbedding(
  ui: ExtensionContext['ui'],
  existing?: OpenLoreConfig['embedding'],
): Promise<OpenLoreConfig['embedding'] | undefined> {
  const embedUrl = (await ui.input(
    existing?.baseUrl ? `Embedding base URL (current: ${existing.baseUrl})` : 'Embedding base URL',
    existing?.baseUrl ?? 'http://localhost:11434',
  )) || existing?.baseUrl || '';
  if (!embedUrl) return undefined;

  const embedSsl = await ui.confirm('Skip SSL verification for embedding?', 'Required for self-signed certificates');
  const embedModels = await fetchModels(embedUrl);
  let embedModel: string;
  if (embedModels && embedModels.length > 0) {
    const currentEmbedModel = existing?.model;
    const embedModelList = currentEmbedModel && embedModels.includes(currentEmbedModel)
      ? [`${currentEmbedModel} *`, ...embedModels.filter((m) => m !== currentEmbedModel)]
      : embedModels;
    const selectedEmbedModel = await ui.select('Embedding model', embedModelList) ?? embedModelList[0];
    embedModel = selectedEmbedModel.replace(/ \*$/, '');
  } else {
    const existingModel = existing?.model ?? '';
    embedModel = (await ui.input(
      existing?.model ? `Embedding model (current: ${existing.model})` : 'Embedding model',
      '',
    )) || existingModel;
  }
  const embedApiKey = process.env['OPENLORE_EMBEDDING_API_KEY'];
  if (!embedApiKey) {
    ui.notify('Embedding API key: set OPENLORE_EMBEDDING_API_KEY in your shell environment (leave unset for Ollama/local endpoints)', 'info');
  }

  return {
    baseUrl: embedUrl,
    model: embedModel,
    ...(embedSsl ? { skipSslVerify: true } : {}),
  };
}

async function runConfigWizard(ctx: ExtensionContext, existing?: OpenLoreConfig | null): Promise<void> {
  const { ui } = ctx;

  // Mutable working copy — sections update independently until "Save".
  let generation = existing?.generation ?? {};
  let embedding = existing?.embedding;
  let maxFiles = existing?.analysis?.maxFiles ?? 500;

  // Menu loop — user picks which section to edit, repeats until Done.
  while (true) {
    const genLabel = generation.provider
      ? `Generation  ${generation.provider} · ${generation.model ?? '—'}${generation.openaiCompatBaseUrl ? ' · ' + generation.openaiCompatBaseUrl : ''}`
      : 'Generation  (not configured)';
    const embedLabel = embedding
      ? `Embedding   ${embedding.baseUrl} · ${embedding.model || '—'}`
      : 'Embedding   (not configured)';
    const analysisLabel = `Analysis    maxFiles=${maxFiles}`;

    const choice = await ui.select('openlore config — what to change?', [
      genLabel,
      embedLabel,
      analysisLabel,
      'Save & close',
    ]);

    if (!choice) return; // escaped — discard all changes
    if (choice === 'Save & close') break;

    if (choice === genLabel) {
      generation = await configureGeneration(ui, generation);
    } else if (choice === embedLabel) {
      embedding = await configureEmbedding(ui, embedding);
    } else if (choice === analysisLabel) {
      const raw = await ui.input(`Max files to analyze (current: ${maxFiles})`, '500');
      maxFiles = parseInt(raw ?? '', 10) || maxFiles;
    }
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
    generation,
    ...(embedding ? { embedding } : {}),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastRun: existing?.lastRun ?? null,
  };

  await writeConfig(ctx.cwd, config);
  ui.notify('Configuration saved.', 'info');

  const runNow = await ui.confirm(
    'Run openlore analyze now?',
    'Builds the structural index required for navigation tools (~30s–2min depending on codebase size)',
  );
  if (runNow) {
    ui.notify('Running openlore analyze…', 'info');
    const [exitCode, errText] = await new Promise<[number, string]>((resolve) => {
      // Try `openlore` in PATH; fall back to `npx openlore` if not found.
      const trySpawn = (cmd: string, args: string[]) => new Promise<[number, string] | null>((res) => {
        const chunks: Buffer[] = [];
        const proc = spawn(cmd, args, { cwd: ctx.cwd, stdio: ['ignore', 'ignore', 'pipe'] });
        proc.stderr?.on('data', (d: Buffer) => chunks.push(d));
        proc.on('close', (code) => res([code ?? 1, Buffer.concat(chunks).toString().trim()]));
        proc.on('error', () => res(null));
      });
      trySpawn('openlore', ['analyze']).then((r) => {
        if (r !== null) return resolve(r);
        return trySpawn('npx', ['openlore', 'analyze']).then((r2) => resolve(r2 ?? [1, 'openlore not found in PATH']));
      });
    });
    if (exitCode === 0) {
      ui.notify('Analysis complete — openlore tools are ready.', 'info');
    } else {
      ui.notify(`openlore analyze failed — run it manually. ${errText ? '(' + errText.slice(0, 120) + ')' : ''}`.trim(), 'error');
    }
  }
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
  pi.registerCommand('openlore', {
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

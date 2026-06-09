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

/** Treat a config as absent unless it has the minimum viable fields. */
export function isUsableConfig(raw: unknown): raw is OpenLoreConfig {
  return !!raw && typeof raw === 'object' && typeof (raw as OpenLoreConfig).generation?.provider === 'string';
}

export async function readConfig(cwd: string): Promise<OpenLoreConfig | null> {
  try {
    const raw = JSON.parse(await readFile(join(cwd, OPENLORE_DIR, 'config.json'), 'utf-8'));
    return isUsableConfig(raw) ? raw : null;
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

/**
 * Build the `/v1/models` URL for a provider base URL, tolerating a trailing
 * slash and an already-present `/v1` segment (e.g. https://api.mistral.ai/v1/).
 */
export function modelsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${base}/v1/models`;
}

/** Strip the trailing " *" current-value marker added to select-list entries. */
export function stripMarker(label: string): string {
  return label.replace(/ \*$/, '');
}

async function fetchModels(baseUrl: string, apiKey?: string): Promise<string[] | null> {
  try {
    const res = await fetch(modelsUrl(baseUrl), {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: { id: string }[] };
    return data.data?.map((m) => m.id).sort() ?? null;
  } catch { return null; }
}

// ── Config wizard ─────────────────────────────────────────────────────────────

const FIELD_PAD = 16; // must be >= longest label length ("Max files" = 9)
const SEP_WIDTH = 36;

function fmtField(label: string, value: string): string {
  return `${label.padEnd(FIELD_PAD)}${value}`;
}

function fmtSep(title?: string): string {
  if (!title) return '─'.repeat(SEP_WIDTH);
  const padded = ` ${title} `;
  const remaining = Math.max(4, SEP_WIDTH - padded.length);
  const left = Math.floor(remaining / 2);
  return '─'.repeat(left) + padded + '─'.repeat(remaining - left);
}

const SEP_GENERATION = fmtSep('Generation (LLM)');
const SEP_EMBEDDING  = fmtSep('Embedding (retrieval)');
const SEP_ANALYSIS   = fmtSep('Analysis');
const SEP_DIVIDER    = fmtSep();


async function runConfigWizard(ctx: ExtensionContext, existing?: OpenLoreConfig | null): Promise<void> {
  const { ui } = ctx;

  let generation: OpenLoreConfig['generation'] = existing?.generation ?? {};
  let embedding = existing?.embedding;
  let maxFiles = existing?.analysis?.maxFiles ?? 500;
  const prevProvider = existing?.generation?.provider;
  const prevModel = existing?.generation?.model;

  if (embedding?.apiKey) {
    embedding = { baseUrl: embedding.baseUrl, model: embedding.model, ...(embedding.skipSslVerify ? { skipSslVerify: true } : {}) };
    ui.notify('Removed stored embedding API key — set OPENLORE_EMBEDDING_API_KEY in your shell instead.', 'warning');
  }

  while (true) {
    // Build menu as parallel (label, handler) pairs so duplicate labels (Model,
    // Skip SSL appear in both sections) dispatch to the correct handler by index.
    type Handler = (() => Promise<void>) | undefined;
    const menu: Array<{ label: string; handler: Handler }> = [];
    const sep  = (s: string)  => menu.push({ label: s, handler: undefined });
    const row  = (label: string, value: string, handler: () => Promise<void>) =>
      menu.push({ label: fmtField(label, value), handler });

    sep(SEP_GENERATION);
    row('Provider', generation.provider ?? '—', async () => {
      const list = generation.provider
        ? [`${generation.provider} *`, ...PROVIDERS.filter((p) => p !== generation.provider)]
        : PROVIDERS;
      const sel = await ui.select('Provider', list);
      if (sel) {
        const next = stripMarker(sel);
        if (next !== generation.provider) {
          generation = { provider: next };
          if (!SYSTEM_AUTH_PROVIDERS.has(next) && PROVIDER_ENV_VARS[next] && !process.env[PROVIDER_ENV_VARS[next]]) {
            ui.notify(`Set ${PROVIDER_ENV_VARS[next]} in your shell environment`, 'warning');
          }
        }
      }
    });

    if (generation.provider) {
      row('Model', generation.model ?? '—', async () => {
        const apiBase = generation.provider === 'openai' ? 'https://api.openai.com' : (generation.openaiCompatBaseUrl ?? '');
        const apiKey = generation.provider ? process.env[PROVIDER_ENV_VARS[generation.provider] ?? ''] : undefined;
        const models = apiBase ? await fetchModels(apiBase, apiKey) : null;
        if (models && models.length > 0) {
          const modelList = generation.model && models.includes(generation.model)
            ? [`${generation.model} *`, ...models.filter((m) => m !== generation.model)]
            : models;
          const sel = await ui.select('Model', modelList);
          if (sel) generation = { ...generation, model: stripMarker(sel) };
        } else {
          const input = await ui.input(
            generation.model ? `Model (current: ${generation.model})` : 'Model',
            PROVIDER_MODEL_DEFAULTS[generation.provider ?? ''] ?? '',
          );
          if (input) generation = { ...generation, model: input };
        }
      });
    }

    if (generation.provider === 'openai-compat') {
      row('Base URL', generation.openaiCompatBaseUrl ?? '—', async () => {
        const input = await ui.input(
          generation.openaiCompatBaseUrl ? `Base URL (current: ${generation.openaiCompatBaseUrl})` : 'Base URL',
          'http://localhost:11434',
        );
        if (input) generation = { ...generation, openaiCompatBaseUrl: input };
      });
      row('Skip SSL', generation.skipSslVerify ? 'yes' : 'no', async () => {
        generation = { ...generation, skipSslVerify: await ui.confirm(
          'Skip SSL verification?',
          'Only enable for local servers with self-signed certificates (e.g. Ollama on localhost). Do NOT enable for remote/cloud endpoints.',
        ) };
      });
    }

    sep(SEP_EMBEDDING);
    row('URL', embedding?.baseUrl ?? '—', async () => {
      const input = await ui.input(
        embedding?.baseUrl ? `Embedding URL (current: ${embedding.baseUrl})` : 'Embedding URL (leave empty to skip)',
        embedding?.baseUrl ?? 'http://localhost:11434',
      );
      if (input) {
        embedding = { baseUrl: input, model: embedding?.model ?? '', ...(embedding?.skipSslVerify ? { skipSslVerify: true } : {}) };
        if (!process.env['OPENLORE_EMBEDDING_API_KEY']) {
          ui.notify('Set OPENLORE_EMBEDDING_API_KEY in your shell (leave unset for Ollama/local endpoints)', 'info');
        }
      }
    });

    if (embedding?.baseUrl) {
      row('Model', embedding.model || '(none)', async () => {
        const models = embedding?.baseUrl ? await fetchModels(embedding.baseUrl) : null;
        if (models && models.length > 0) {
          const cur = embedding?.model;
          const modelList = cur && models.includes(cur)
            ? [`${cur} *`, ...models.filter((m) => m !== cur)]
            : models;
          const sel = await ui.select('Embedding model', modelList);
          if (sel && embedding) embedding = { ...embedding, model: stripMarker(sel) };
        } else {
          const input = await ui.input(
            embedding?.model ? `Model (current: ${embedding.model})` : 'Model',
            '',
          );
          if (input && embedding) embedding = { ...embedding, model: input };
        }
      });
      row('Skip SSL', embedding.skipSslVerify ? 'yes' : 'no', async () => {
        if (embedding) embedding = { ...embedding, skipSslVerify: await ui.confirm(
          'Skip SSL for embedding?',
          'Only enable for local servers with self-signed certificates (e.g. Ollama on localhost). Do NOT enable for remote/cloud endpoints.',
        ) };
      });
      menu.push({ label: '✕ Remove embedding', handler: async () => { embedding = undefined; } });
    }

    sep(SEP_ANALYSIS);
    row('Max files', String(maxFiles), async () => {
      const raw = await ui.input(`Max files to analyze (current: ${maxFiles})`, String(maxFiles));
      maxFiles = parseInt(raw ?? '', 10) || maxFiles;
    });
    sep(SEP_DIVIDER);
    menu.push({ label: '✓ Save & close',    handler: undefined });
    menu.push({ label: '✕ Discard & close', handler: undefined });

    const labels = menu.map((m) => m.label);
    const choice = await ui.select('openlore config', labels);

    if (!choice || choice === '✕ Discard & close') return;
    if (choice === '✓ Save & close') break;

    const idx = labels.indexOf(choice);
    if (idx !== -1) await menu[idx].handler?.();
  }

  const config: OpenLoreConfig = {
    version: existing?.version ?? '1.0.0',
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

  const generationChanged = generation.provider !== prevProvider || generation.model !== prevModel;
  if (generationChanged) {
    const runNow = await ui.confirm(
      'Run openlore analyze now?',
      'Builds the structural index required for navigation tools (~30s–2min depending on codebase size)',
    );
    if (runNow) {
      ui.notify('Running openlore analyze…', 'info');
      const [exitCode, errText] = await new Promise<[number, string]>((resolve) => {
        const trySpawn = (cmd: string, args: string[]) => new Promise<[number, string] | null>((res) => {
          const chunks: Buffer[] = [];
          const proc = spawn(cmd, args, { cwd: ctx.cwd, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, ...(process.platform === 'win32' ? { shell: true } : {}) });
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
    spawn('openlore', ['serve', '--directory', cwd], { detached: true, stdio: 'ignore', windowsHide: true, ...(process.platform === 'win32' ? { shell: true } : {}) }).unref();
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
  const daemons = new Map<string, Daemon>();
  // Negative cache: when a daemon can't be reached, remember the failure for a
  // short window so we don't pay the full 8s spawn-and-poll on every call in a
  // repo that simply isn't analyzed yet. Transient failures recover after TTL.
  const failedUntil = new Map<string, number>();
  const DAEMON_RETRY_COOLDOWN_MS = 30_000;
  const primed = new Set<string>();
  let sessionCwd = process.cwd();
  let sessionMode: ExtensionContext['mode'] = 'tui';

  async function getDaemon(cwd: string): Promise<Daemon | null> {
    const cached = daemons.get(cwd);
    if (cached) return cached;
    if ((failedUntil.get(cwd) ?? 0) > Date.now()) return null;
    const d = await ensureDaemon(cwd);
    if (d) {
      daemons.set(cwd, d);
      failedUntil.delete(cwd);
    } else {
      failedUntil.set(cwd, Date.now() + DAEMON_RETRY_COOLDOWN_MS);
    }
    return d;
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

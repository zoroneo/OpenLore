/**
 * openlore.ts — Pi extension (pi.dev)
 *
 * Brings openlore's deterministic structural context into Pi for local models
 * (Qwen, Gemma, …) without MCP. It talks to a warm `openlore serve` HTTP daemon
 * over loopback, so:
 *   • tool calls hit warm caches (orient ~8ms vs ~100ms cold),
 *   • the daemon's watcher keeps analysis continuously fresh between commits.
 *
 * Two halves:
 *   C — context injection (before_agent_start): the model starts grounded with
 *       the architecture digest + spec index + a task-specific orient, so weak
 *       tool-callers benefit even if they never call a tool.
 *   B — native tools (registerTool): the navigation surface for on-demand
 *       "how does X reach Y" — each shells to the daemon via fetch.
 *
 * Install: copy to ~/.pi/agent/extensions/openlore.ts (global) or
 * <project>/.pi/extensions/openlore.ts, or run `openlore setup --tools pi`.
 *
 * Requires `openlore` on PATH and `openlore analyze` to have been run once.
 *
 * Imports verified against pi 0.78 (`Type` from typebox, `StringEnum` from
 * @earendil-works/pi-ai, extension types from @earendil-works/pi-coding-agent).
 */

import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { StringEnum } from '@earendil-works/pi-ai';
import { Type } from 'typebox';

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Trim text to a max length with a marker — keeps small-model context lean. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `\n… (truncated, ${s.length - max} more chars)`;
}

// ── Daemon discovery + lifecycle ─────────────────────────────────────────────

interface ServeDescriptor {
  port: number;
  pid: number;
  host: string;
  token?: string;
  version: string;
}

interface Daemon {
  baseUrl: string;
  token?: string;
}

const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_POLL_MS = 150;
const RESULT_MAX = 50_000; // truncate tool output to keep small-model context lean

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Read <cwd>/.openlore/serve.json if a daemon previously announced itself. */
async function readDescriptor(cwd: string): Promise<ServeDescriptor | null> {
  try {
    const raw = await readFile(join(cwd, '.openlore', 'serve.json'), 'utf-8');
    return JSON.parse(raw) as ServeDescriptor;
  } catch {
    return null;
  }
}

/**
 * GET /health — confirms a descriptor points at a live openlore daemon, not a
 * stale serve.json or a recycled port now owned by an unrelated server. Checks
 * the `ok: true` response shape, not just a 200.
 */
async function health(desc: ServeDescriptor): Promise<boolean> {
  try {
    const res = await fetch(`http://${desc.host}:${desc.port}/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!res.ok) return false;
    const body = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    return body?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Return a live daemon for `cwd`: reuse an announced one if healthy, otherwise
 * spawn `openlore serve` detached and poll until /health is ready.
 * Returns null if no daemon could be brought up (caller degrades gracefully).
 * Never kills a daemon it didn't start — it may serve other clients.
 */
async function ensureDaemon(cwd: string): Promise<Daemon | null> {
  const existing = await readDescriptor(cwd);
  if (existing && (await health(existing))) {
    return { baseUrl: `http://${existing.host}:${existing.port}`, token: existing.token };
  }

  // Spawn detached so the daemon outlives this pi session. No --watch flag:
  // watch is on by default (only --no-watch disables it).
  try {
    const child = spawn('openlore', ['serve', '--directory', cwd], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    return null; // openlore not on PATH
  }

  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(HEALTH_POLL_MS);
    const desc = await readDescriptor(cwd);
    if (desc && (await health(desc))) {
      return { baseUrl: `http://${desc.host}:${desc.port}`, token: desc.token };
    }
  }
  return null;
}

/** POST /tool/:name → parsed JSON, or { error } on any transport failure. */
async function callTool(
  daemon: Daemon,
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  signal?: AbortSignal,
): Promise<unknown> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (daemon.token) headers['x-openlore-token'] = daemon.token;
  try {
    const res = await fetch(`${daemon.baseUrl}/tool/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ directory: cwd, args }),
      signal,
    });
    const body = await res.json().catch(() => ({ error: `non-JSON response (${res.status})` }));
    if (!res.ok) return { error: (body as { error?: string }).error ?? `HTTP ${res.status}` };
    return body;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Context injection helpers (file-based, no subprocess) ─────────────────────

/** Architecture digest written by `openlore analyze`. */
async function readDigest(cwd: string): Promise<string> {
  try {
    return await readFile(join(cwd, '.openlore', 'analysis', 'CODEBASE.md'), 'utf-8');
  } catch {
    return '';
  }
}

/** Compact one-line-per-domain spec index from openspec/specs/. */
async function readSpecIndex(cwd: string): Promise<string> {
  try {
    const { readdir } = await import('node:fs/promises');
    const specsDir = join(cwd, 'openspec', 'specs');
    const dirs = (await readdir(specsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    if (dirs.length === 0) return '';
    return ['## openlore spec domains', ...dirs.map((d) => `- ${d}`)].join('\n');
  } catch {
    return '';
  }
}

// ── Tool surface (navigation preset, tuned terse for small models) ────────────

interface ToolSpec {
  name: string;
  label: string;
  description: string;
  guideline: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  parameters: any;
}

const TOOLS: ToolSpec[] = [
  {
    name: 'orient',
    label: 'openlore orient',
    description:
      'START HERE on any new task. Returns relevant functions, files, spec domains, ' +
      'call neighbours, and insertion points in one call.',
    guideline: 'Use openlore_orient FIRST on any new task before reading files.',
    parameters: Type.Object({
      task: Type.String({ description: 'Natural-language task description' }),
      limit: Type.Optional(Type.Number({ description: 'Max relevant functions (default 5)' })),
    }),
  },
  {
    name: 'search_code',
    label: 'openlore search_code',
    description: 'Semantic + keyword search for functions by meaning or name.',
    guideline: 'Use openlore_search_code to find where a concept lives instead of grepping.',
    parameters: Type.Object({
      query: Type.String({ description: 'What to find' }),
      limit: Type.Optional(Type.Number()),
      language: Type.Optional(Type.String()),
    }),
  },
  {
    name: 'get_subgraph',
    label: 'openlore get_subgraph',
    description: 'Call topology around a function (callers/callees) to a given depth.',
    guideline: 'Use openlore_get_subgraph to see blast radius before changing a function.',
    parameters: Type.Object({
      functionName: Type.String(),
      direction: Type.Optional(StringEnum(['downstream', 'upstream', 'both'] as const)),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'trace_execution_path',
    label: 'openlore trace_execution_path',
    description: 'Find call paths from an entry function to a target function.',
    guideline: 'Use openlore_trace_execution_path to answer "how does X reach Y".',
    parameters: Type.Object({
      entryFunction: Type.String(),
      targetFunction: Type.String(),
      maxDepth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'analyze_impact',
    label: 'openlore analyze_impact',
    description: 'Blast radius of changing a symbol (transitive dependents).',
    guideline: 'Use openlore_analyze_impact before editing a shared/hub symbol.',
    parameters: Type.Object({
      symbol: Type.String(),
      depth: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'suggest_insertion_points',
    label: 'openlore suggest_insertion_points',
    description: 'Where to add a feature — ranked file/function insertion candidates.',
    guideline: 'Use openlore_suggest_insertion_points when planning where new code goes.',
    parameters: Type.Object({
      description: Type.String(),
      limit: Type.Optional(Type.Number()),
    }),
  },
  {
    name: 'get_function_skeleton',
    label: 'openlore get_function_skeleton',
    description: 'Compact skeleton of a file: signatures + control flow, noise stripped.',
    guideline: 'Use openlore_get_function_skeleton to read a file cheaply before opening it.',
    parameters: Type.Object({
      filePath: Type.String(),
    }),
  },
];

// ── Extension entry point ────────────────────────────────────────────────────

export default function openlore(pi: ExtensionAPI): void {
  // One daemon per project cwd for this pi process.
  const daemons = new Map<string, Daemon | null>();
  // Inject the heavy session primer only once per session.
  const primed = new Set<string>();
  // before_agent_start receives only `event` (no ctx in pi's API), so capture
  // the working directory from session_start and reuse it there.
  let sessionCwd = process.cwd();

  async function getDaemon(cwd: string): Promise<Daemon | null> {
    if (!daemons.has(cwd)) daemons.set(cwd, await ensureDaemon(cwd));
    return daemons.get(cwd) ?? null;
  }

  // ── B: native tools ──
  for (const tool of TOOLS) {
    pi.registerTool({
      name: `openlore_${tool.name}`,
      label: tool.label,
      description: tool.description,
      promptSnippet: tool.description,
      promptGuidelines: [tool.guideline],
      parameters: tool.parameters,
      async execute(_id: string, params: Record<string, unknown>, signal: AbortSignal, _onUpdate: unknown, ctx: ExtensionContext) {
        const cwd = ctx.cwd;
        const daemon = await getDaemon(cwd);
        if (!daemon) {
          return {
            content: [{ type: 'text', text: 'openlore daemon unavailable — run `openlore analyze` then retry, or check `openlore` is on PATH.' }],
          };
        }
        const result = await callTool(daemon, tool.name, params, cwd, signal);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { content: [{ type: 'text', text: truncate(text, RESULT_MAX) }], details: result };
      },
    });
  }

  // ── Lifecycle: warm the daemon at session start (best-effort) ──
  pi.on('session_start', async (_event: unknown, ctx: ExtensionContext) => {
    sessionCwd = ctx.cwd;
    await getDaemon(ctx.cwd);
  });

  // ── C: context injection on the first turn ──
  pi.on('before_agent_start', async (event: { systemPrompt: string }) => {
    const cwd = sessionCwd;
    if (primed.has(cwd)) return undefined;
    primed.add(cwd);

    const blocks: string[] = [];

    const digest = await readDigest(cwd);
    if (digest) blocks.push('# Codebase architecture (openlore)\n\n' + truncate(digest, 8000));

    const specIndex = await readSpecIndex(cwd);
    if (specIndex) blocks.push(specIndex);

    // Task-grounded primer: orient on the user's first message.
    const firstUserMsg = extractFirstUserText(event);
    const daemon = await getDaemon(cwd);
    if (daemon && firstUserMsg) {
      const oriented = await callTool(daemon, 'orient', { task: firstUserMsg }, cwd);
      if (oriented && typeof oriented === 'object' && !('error' in (oriented as object))) {
        blocks.push('# openlore orientation for this task\n\n' + truncate(JSON.stringify(oriented, null, 2), 6000));
      }
    }

    if (blocks.length === 0) {
      // No analysis yet — nudge once, never block the turn.
      return {
        systemPrompt:
          event.systemPrompt +
          '\n\n[openlore: no analysis found — run `openlore analyze` to enable structural context + tools.]',
      };
    }

    return { systemPrompt: event.systemPrompt + '\n\n' + blocks.join('\n\n') };
  });
}

/** Best-effort pull of the first user message text from the before_agent_start event. */
function extractFirstUserText(event: unknown): string {
  const e = event as { messages?: Array<{ role?: string; content?: unknown }> };
  const msg = e.messages?.find((m) => m.role === 'user');
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((p: unknown) => (typeof p === 'object' && p && 'text' in p ? String((p as { text: unknown }).text) : ''))
      .join(' ')
      .trim();
  }
  return '';
}

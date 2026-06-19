/**
 * Trust-calibrated context economy — re-read measurement (item 4 of
 * `add-trust-calibrated-context-economy`).
 *
 * Pure, deterministic extraction of the "re-read economy" signals from a headless
 * agent transcript (`claude -p --output-format stream-json`), so the bench harness
 * (`scripts/bench-agent.ts`) can report — honestly, per repo tier — how much
 * re-derivation openlore actually removes:
 *
 *   - `fileReadOps`     — how many times the agent re-read source (Read/Grep/cat/…)
 *                         to derive a fact. The thing a grounding certificate lets
 *                         it skip. WITHOUT − WITH = re-reads avoided.
 *   - `fileReadTokens`  — the tokens those reads loaded into the model (≈ len/4).
 *                         WITHOUT − WITH = the token delta the lever is responsible
 *                         for — the rent openlore is supposed to subtract.
 *   - `certifiedFacts`  — `verifiedCurrent: true` facts openlore handed the agent
 *                         (the "permission to not re-read" markers). WITH-arm only.
 *
 * Lives in `src/` (not `scripts/`) purely so CI's `vitest run src` covers it; the
 * benchmark is the only consumer. No product code depends on it.
 */

/** A normalized agent tool invocation (transport-shape stripped). */
export interface NormToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/** A normalized tool result, flattened to plain text. */
export interface NormToolResult {
  toolUseId: string;
  text: string;
}

export interface AgentTranscript {
  toolUses: NormToolUse[];
  toolResults: NormToolResult[];
}

/** The terminal result event — mirrors the legacy single-object `--output-format json`. */
export interface AgentResultEnvelope {
  freshInputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
  numTurns: number;
  durationMs: number;
  answer: string;
}

export interface RereadMetrics {
  fileReadOps: number;
  fileReadTokens: number;
  certifiedFacts: number;
}

/** ~bytes/4 token heuristic — the same approximation the tool-surface figures use. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Classify a tool invocation for the re-read economy.
 * - `source-read`: the agent reads/searches source to derive a fact (Read, Grep, or
 *   a shell read like cat/sed/head/tail/less/grep/rg/awk) — what a certificate replaces.
 * - `openlore`: an openlore MCP tool (its conclusions are what the agent reads instead).
 * - `other`: writes, task tools, etc. — irrelevant to the re-read lever.
 *
 * The Bash classifier is a deliberate heuristic, not a shell parser. It catches a reader
 * at line start (incl. indented / multi-line commands via the `m` flag) or after a
 * pipe/and/semicolon/`do`/`xargs`, tolerating an env-var-assignment or `sudo` prefix.
 * Two residual biases are accepted and roughly offset: (a) a reader fed by a pipe
 * (`npm build | grep err`) consumes the prior command's stdout, not source, yet counts as
 * a source-read (over-count); (b) `Read`/`Grep` are classified by tool name alone — the
 * `file_path` is not inspected, so reading a non-source file (e.g. a `.md` or an openlore
 * artifact) also counts. Both are small relative to the per-task read volume; the metric
 * is a directional measurement, not an exact accounting.
 */
export function classifyToolUse(name: string, input: Record<string, unknown>): 'source-read' | 'openlore' | 'other' {
  if (name.startsWith('mcp__openlore__')) return 'openlore';
  if (name === 'Read' || name === 'Grep') return 'source-read';
  if (name === 'Bash') {
    const cmd = typeof input.command === 'string' ? input.command : '';
    // A shell read of source: a reader at line start (m-flag → indented / later lines of a
    // multi-line command), or after a pipe/and/semicolon/`do`/`xargs`, allowing an env-var
    // assignment or `sudo` prefix. `echo cat` (reader inside a word/string) still does not match.
    if (/(?:^|[|&;]|\bdo\b|\bxargs\b)\s*(?:\w+=\S+\s+)*(?:sudo\s+)?(?:cat|sed|head|tail|less|grep|rg|awk)\b/m.test(cmd)) return 'source-read';
  }
  return 'other';
}

/** Count `verifiedCurrent: true` markers in an openlore result payload (regex-robust to shape). */
export function countVerifiedCurrent(text: string): number {
  const m = text.match(/"verifiedCurrent"\s*:\s*true/g);
  return m ? m.length : 0;
}

/** Flatten a tool_result `content` (string | array of text parts | object) to plain text. */
function flattenContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return JSON.stringify(part);
      })
      .join('');
  }
  if (content == null) return '';
  return JSON.stringify(content);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

/**
 * Parse the agent's stdout into a normalized transcript + terminal result. Accepts
 * BOTH `--output-format stream-json` (newline-delimited events) and the legacy
 * single-object `--output-format json` (result only, no transcript) — so switching
 * the harness to stream-json is robust and the result/usage extraction is unchanged.
 * Malformed lines are skipped; nothing throws.
 */
export function parseAgentOutput(raw: string): { transcript: AgentTranscript; result?: AgentResultEnvelope } {
  const toolUses: NormToolUse[] = [];
  const toolResults: NormToolResult[] = [];
  let result: AgentResultEnvelope | undefined;

  const events: Record<string, unknown>[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { events.push(asRecord(JSON.parse(t))); } catch { /* skip non-JSON noise */ }
  }
  // Legacy: a single object that is itself the result (no `type` discriminator).
  if (events.length === 1 && events[0].type === undefined && (events[0].usage !== undefined || events[0].result !== undefined)) {
    return { transcript: { toolUses, toolResults }, result: extractResult(events[0]) };
  }
  for (const ev of events) {
    const type = ev.type;
    if (type === 'assistant') {
      const content = asRecord(ev.message).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b.type === 'tool_use') {
            toolUses.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: asRecord(b.input) });
          }
        }
      }
    } else if (type === 'user') {
      const content = asRecord(ev.message).content;
      if (Array.isArray(content)) {
        for (const block of content) {
          const b = asRecord(block);
          if (b.type === 'tool_result') {
            toolResults.push({ toolUseId: String(b.tool_use_id ?? ''), text: flattenContent(b.content) });
          }
        }
      }
    } else if (type === 'result') {
      result = extractResult(ev);
    }
  }
  return { transcript: { toolUses, toolResults }, result };
}

/** Pull the usage/cost/answer envelope from a `result` event or a legacy json object. */
function extractResult(ev: Record<string, unknown>): AgentResultEnvelope {
  const usage = asRecord(ev.usage);
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    freshInputTokens: num(usage.input_tokens) + num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    outputTokens: num(usage.output_tokens),
    costUsd: num(ev.total_cost_usd),
    numTurns: num(ev.num_turns),
    durationMs: num(ev.duration_ms),
    answer: String(ev.result ?? ''),
  };
}

/**
 * Compute the re-read economy from a normalized transcript. Deterministic: counts
 * source-read tool uses, sums the tokens their results loaded, and counts the
 * verified-current certificates openlore returned.
 */
export function analyzeAgentTranscript(t: AgentTranscript): RereadMetrics {
  const resultByUseId = new Map<string, string>();
  for (const r of t.toolResults) resultByUseId.set(r.toolUseId, r.text);

  let fileReadOps = 0;
  let fileReadTokens = 0;
  let certifiedFacts = 0;

  for (const use of t.toolUses) {
    const kind = classifyToolUse(use.name, use.input);
    if (kind === 'source-read') {
      fileReadOps += 1;
      const out = resultByUseId.get(use.id);
      if (out) fileReadTokens += estimateTokens(out);
    } else if (kind === 'openlore') {
      const out = resultByUseId.get(use.id);
      if (out) certifiedFacts += countVerifiedCurrent(out);
    }
  }
  return { fileReadOps, fileReadTokens, certifiedFacts };
}

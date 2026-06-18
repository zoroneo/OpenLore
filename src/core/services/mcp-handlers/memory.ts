/**
 * MCP tool handlers: code-anchored agent memory.
 * (change: add-code-anchored-memory-staleness)
 *
 *   remember — persist a durable, code-anchored note for any agent to recall later
 *   recall   — return memories relevant to a task, each with a deterministic
 *              freshness verdict; an orphaned memory is NEVER served as
 *              authoritative context (the bullet-proof guarantee).
 *
 * Notes live in .openlore/memory/notes.json, entirely separate from the decision
 * store and commit gate. Architectural decisions are recalled too (read-only) so
 * one call surfaces all anchored memory touching a task. Freshness is static
 * analysis only — no LLM. With no `task`, recall doubles as a memory-staleness
 * scan over everything persisted.
 */

import { validateDirectory, sanitizeMcpError } from './utils.js';
import { loadDecisionStore, INACTIVE_STATUSES } from '../../decisions/store.js';
import { loadMemoryStore, updateMemoryStore, makeMemoryId } from '../../decisions/memory-store.js';
import { AnchorContext } from '../../decisions/anchor-adapter.js';
import { memoryFreshness, decisionAnchors, type GraphFreshnessView } from '../../decisions/anchor.js';
import type {
  AnchoredMemory,
  StructuralAnchor,
  PendingDecision,
  AnchorVerdict,
} from '../../../types/index.js';

// ── remember ────────────────────────────────────────────────────────────────

export interface AnchorHint {
  symbol?: string;
  file?: string;
}

export async function handleRemember(
  directory: string,
  content: string,
  anchorHints?: AnchorHint[],
  tags?: string[],
): Promise<unknown> {
  try {
    if (!content?.trim()) return { error: 'content is required and must not be empty.' };
    const rootPath = await validateDirectory(directory);

    let anchors: StructuralAnchor[] = [];
    if (anchorHints?.length) {
      const ctx = AnchorContext.open(rootPath);
      if (ctx) {
        try {
          anchors = ctx.resolveInputAnchors(anchorHints);
        } finally {
          ctx.close();
        }
      } else {
        // No analysis yet — keep file hints as existence-only file anchors.
        anchors = anchorHints
          .filter((h) => h.file)
          .map((h) => ({ filePath: h.file! }));
      }
    }

    const recordedAt = new Date().toISOString();
    const memory: AnchoredMemory = {
      id: makeMemoryId(content.trim(), recordedAt),
      kind: 'note',
      content: content.trim(),
      anchors,
      recordedAt,
      tags: tags?.length ? tags : undefined,
    };

    // CAS update so concurrent remember calls never lose a write: the id-keyed
    // upsert is re-applied to the latest store on a write conflict.
    await updateMemoryStore(rootPath, (store) => ({
      ...store,
      memories: [...store.memories.filter((m) => m.id !== memory.id), memory],
    }));

    return {
      id: memory.id,
      anchored: anchors.length > 0,
      anchors: anchors.map(summarizeAnchor),
      message: anchors.length
        ? `Memory recorded with ${anchors.length} structural anchor(s).`
        : 'Memory recorded (unanchored — recall will not be able to verify it against code).',
    };
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ── recall ────────────────────────────────────────────────────────────────────

interface RecalledMemory {
  kind: 'note' | 'decision';
  id: string;
  text: string;
  freshness: 'fresh' | 'drifted' | 'orphaned';
  anchored: boolean;
  /** Set on drifted memories: the described code changed since recording. */
  verify?: boolean;
  anchors: ReturnType<typeof summarizeVerdict>[];
  recordedAt?: string;
  score: number;
}

export async function handleRecall(
  directory: string,
  task?: string,
  limit = 10,
): Promise<unknown> {
  try {
    const rootPath = await validateDirectory(directory);

    const [memStore, decisionStore] = await Promise.all([
      loadMemoryStore(rootPath),
      loadDecisionStore(rootPath),
    ]);

    const ctx = AnchorContext.open(rootPath);
    const view: GraphFreshnessView = ctx
      ? ctx.freshnessView()
      : { nodeHash: () => undefined, fileExists: () => false, fileHash: () => undefined };

    try {
      const queryTokens = tokenize(task ?? '');
      const items: RecalledMemory[] = [];

      for (const m of memStore.memories) {
        const f = memoryFreshness(m.anchors, view);
        items.push({
          kind: 'note',
          id: m.id,
          text: m.content,
          freshness: f.freshness,
          anchored: f.anchored,
          verify: f.freshness === 'drifted' ? true : undefined,
          anchors: f.verdicts.map(summarizeVerdict),
          recordedAt: m.recordedAt,
          score: relevance(queryTokens, `${m.content} ${(m.tags ?? []).join(' ')} ${anchorFiles(m.anchors)}`),
        });
      }

      for (const d of activeDecisions(decisionStore.decisions)) {
        const anchors = decisionAnchors(d);
        const f = memoryFreshness(anchors, view);
        items.push({
          kind: 'decision',
          id: d.id,
          text: d.title,
          freshness: f.freshness,
          anchored: f.anchored,
          verify: f.freshness === 'drifted' ? true : undefined,
          anchors: f.verdicts.map(summarizeVerdict),
          recordedAt: d.recordedAt,
          score: relevance(queryTokens, `${d.title} ${d.rationale} ${d.affectedFiles.join(' ')}`),
        });
      }

      const filtered = (queryTokens.length ? items.filter((i) => i.score > 0) : items)
        .sort((a, b) => b.score - a.score || (b.recordedAt ?? '').localeCompare(a.recordedAt ?? ''))
        .slice(0, Math.max(1, limit));

      // The bullet-proof guarantee: orphaned memories never sit in `authoritative`.
      const authoritative = filtered.filter((i) => i.freshness !== 'orphaned');
      const needsReanchoring = filtered.filter((i) => i.freshness === 'orphaned');

      return {
        task: task ?? null,
        graphAvailable: ctx !== null,
        total: filtered.length,
        summary: {
          fresh: filtered.filter((i) => i.freshness === 'fresh').length,
          drifted: filtered.filter((i) => i.freshness === 'drifted').length,
          orphaned: needsReanchoring.length,
        },
        authoritative: authoritative.map(stripScore),
        needsReanchoring: needsReanchoring.map(stripScore),
        note: needsReanchoring.length
          ? 'needsReanchoring entries reference code that no longer exists — do not treat them as authoritative; re-record them against current code.'
          : undefined,
      };
    } finally {
      ctx?.close();
    }
  } catch (err) {
    return { error: sanitizeMcpError(err) };
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function activeDecisions(decisions: PendingDecision[]): PendingDecision[] {
  return decisions.filter((d) => !INACTIVE_STATUSES.has(d.status));
}

function tokenize(s: string): string[] {
  return [...new Set((s.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []))];
}

function relevance(queryTokens: string[], haystack: string): number {
  if (!queryTokens.length) return 0;
  const hay = haystack.toLowerCase();
  let score = 0;
  for (const t of queryTokens) if (hay.includes(t)) score++;
  return score;
}

function anchorFiles(anchors: StructuralAnchor[]): string {
  return anchors.map((a) => a.filePath).join(' ');
}

function summarizeAnchor(a: StructuralAnchor): { symbol?: string; file: string; level: 'symbol' | 'file' } {
  return { symbol: a.symbolName, file: a.filePath, level: a.nodeId ? 'symbol' : 'file' };
}

function summarizeVerdict(v: AnchorVerdict): {
  symbol?: string;
  file: string;
  level: 'symbol' | 'file';
  freshness: 'fresh' | 'drifted' | 'orphaned';
  relocatedTo?: string;
} {
  return { ...summarizeAnchor(v.anchor), freshness: v.freshness, relocatedTo: v.relocatedTo };
}

function stripScore(i: RecalledMemory): Omit<RecalledMemory, 'score'> {
  const { score: _score, ...rest } = i;
  void _score;
  return rest;
}

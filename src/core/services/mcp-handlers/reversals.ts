/**
 * ReversalAwareness — shared do-not-repeat logic (add-cross-agent-intent-handoff).
 *
 * Reverted/superseded intent surfaced as a cautionary "do not re-attempt" warning,
 * so an agent does not re-introduce an approach a prior agent/human already tried and
 * removed. Used by BOTH `orient` (the briefing surface) and `recall` (the dedicated
 * memory-retrieval surface) — they differ only in how they derive the scope; the
 * selection, rendering, ordering, and bounded-omission rules live here.
 *
 * Reverted intent is NEVER served as authoritative current context.
 */
import type { AnchoredMemory, PendingDecision } from '../../../types/index.js';

/** A reverted/superseded piece of intent surfaced as a do-not-repeat warning. */
export interface Reversal {
  /** Where the reverted record came from. `note` marks an omission placeholder. */
  source: 'memory' | 'decision' | 'note';
  /** Id of the reverted memory/decision. Absent on a `note` placeholder. */
  id?: string;
  /** The reverted approach: the old memory content or decision title. Absent on a `note`. */
  what?: string;
  /** Recorded reason for the reversal (the superseding item's content/rationale). */
  reason?: string;
  /** Reverting commit SHA — present only for memory reversals (invalidatedByCommit). */
  revertedAtCommit?: string;
  /** Transaction-time the reversal was recorded (ISO). */
  revertedAt?: string;
  /** Id of the memory/decision that superseded this one. */
  supersededBy?: string;
  /** Pre-rendered conclusion the agent can act on directly. */
  warning: string;
}

/** Render the do-not-repeat conclusion for a reverted record. Deterministic, no LLM. */
export function renderReversalWarning(what: string, commit?: string, reason?: string): string {
  const where = commit ? ` (reverted at commit ${commit.slice(0, 8)})` : ' (reverted)';
  const why = reason ? ` — recorded reason: ${reason}` : '';
  return `Do not re-attempt: ${what}${where}${why}`;
}

/** Default cap on reversals surfaced, with an explicit omission note past it. */
export const MAX_REVERSALS = 10;

export interface ReversalScope {
  /** True if this reverted memory is in the caller's scope (orient: by file; recall: by task). */
  memoryInScope: (m: AnchoredMemory) => boolean;
  /** True if this reverted decision (the superseded one) is in the caller's scope. */
  decisionInScope: (superseded: PendingDecision) => boolean;
}

/** Scope predicates anchored to a fixed set of files/domains — the orient-style scope. */
export function fileScope(scopeFiles: ReadonlySet<string>, relevantDomainSet?: ReadonlySet<string>): ReversalScope {
  return {
    memoryInScope: (m) => m.anchors.some((a) => !!a.filePath && scopeFiles.has(a.filePath)),
    decisionInScope: (a) =>
      (relevantDomainSet !== undefined && a.affectedDomains.some((dom) => relevantDomainSet.has(dom))) ||
      a.affectedFiles.some((f) => scopeFiles.has(f)),
  };
}

/**
 * Collect reverted intent in scope as do-not-repeat warnings, sorted most-recent
 * first and bounded with an explicit omission note (history is never silently
 * truncated). Returns `undefined` when nothing in scope was reverted.
 *
 * - A reverted **memory** is one with `invalidatedAt` set that the caller's
 *   `memoryInScope` accepts; its reverting commit is `invalidatedByCommit` and its
 *   reason is the content of the memory that superseded it (via the supersedes link).
 * - A reverted **decision** A is one explicitly superseded by another decision B
 *   (`B.supersedes === A.id`) that the caller's `decisionInScope` accepts; the reason
 *   is B's rationale. Decisions carry no commit SHA, so none is surfaced for that path.
 */
export function collectReversals(
  memories: readonly AnchoredMemory[],
  decisions: readonly PendingDecision[],
  scope: ReversalScope,
  maxReversals: number = MAX_REVERSALS,
): Reversal[] | undefined {
  const rev: Reversal[] = [];

  const supersederByTarget = new Map<string, AnchoredMemory>();
  for (const n of memories) if (n.supersedes) supersederByTarget.set(n.supersedes, n);
  for (const m of memories) {
    if (!m.invalidatedAt) continue;
    if (!scope.memoryInScope(m)) continue;
    const by = supersederByTarget.get(m.id);
    rev.push({
      source: 'memory',
      id: m.id,
      what: m.content,
      reason: by?.content,
      revertedAtCommit: m.invalidatedByCommit,
      revertedAt: m.invalidatedAt,
      supersededBy: by?.id,
      warning: renderReversalWarning(m.content, m.invalidatedByCommit, by?.content),
    });
  }

  const decById = new Map(decisions.map((d) => [d.id, d]));
  for (const b of decisions) {
    if (!b.supersedes) continue;
    const a = decById.get(b.supersedes);
    if (!a) continue;
    if (!scope.decisionInScope(a)) continue;
    rev.push({
      source: 'decision',
      id: a.id,
      what: a.title,
      reason: b.rationale,
      revertedAt: b.recordedAt,
      supersededBy: b.id,
      warning: renderReversalWarning(a.title, undefined, b.rationale),
    });
  }

  if (rev.length === 0) return undefined;
  // Most-recent reversal first; bounded with an explicit omission note.
  rev.sort((x, y) => (y.revertedAt ?? '').localeCompare(x.revertedAt ?? ''));
  const out = rev.slice(0, maxReversals);
  if (rev.length > maxReversals) {
    // Omission placeholder — no id/what so a `find(x => x.id === …)` consumer can't
    // match it; the warning carries the count.
    out.push({
      source: 'note',
      warning: `${rev.length - maxReversals} more reverted item(s) in scope not shown — raise the limit or query recall for the full history.`,
    });
  }
  return out;
}

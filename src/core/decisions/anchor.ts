/**
 * Code-anchored memory — deterministic anchoring + freshness engine.
 * (change: add-code-anchored-memory-staleness)
 *
 * A persisted memory (an architectural decision or a `remember` note) is bound to
 * the code it describes by one or more {@link StructuralAnchor}s. At recall time
 * a freshness verdict is computed against the *current* call graph using only
 * boolean inputs — symbol existence and content-hash equality — with no tunable
 * threshold and no weighted score. This is what lets recall be bullet-proof: a
 * memory whose anchored code moved or died is labeled, never served silently.
 *
 * This module is intentionally pure: it operates on a minimal node view and a
 * {@link GraphFreshnessView} of lookups, so the resolution/verdict logic is unit
 * tested without touching disk or the edge store. The disk-backed adapter that
 * supplies the views lives in `anchor-adapter.ts`.
 */

import { createHash } from 'node:crypto';
import type {
  StructuralAnchor,
  AnchorVerdict,
  MemoryFreshness,
  PendingDecision,
} from '../../types/index.js';

/** Stable, reproducible hash of a source span (or whole file). Unnormalized. */
export function hashSpan(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** Minimal node view the anchor engine needs to resolve a symbol to an anchor. */
export interface AnchorNode {
  id: string;
  name: string;
  filePath: string;
  /** Current hash of the node's source span. */
  contentHash: string;
  /** Content-addressed stable id, when the symbol has a derivable one. */
  stableId?: string;
}

/** Current-state lookups used to compute freshness against the live graph. */
export interface GraphFreshnessView {
  /** Current content hash for a node id, or `undefined` if the node is gone. */
  nodeHash(nodeId: string): string | undefined;
  fileExists(filePath: string): boolean;
  /** Current whole-file content hash, or `undefined` if the file is gone. */
  fileHash(filePath: string): string | undefined;
  /**
   * Resolve a symbol by its content-addressed stable id when its `nodeId` no
   * longer matches (the symbol was moved/renamed-file but otherwise survives).
   * Returns the relocated node's id + current span hash, or `undefined` when no
   * unambiguous node carries that stable id. Optional — absent on legacy views.
   * (change: add-content-addressed-stable-symbol-ids)
   *
   * Resolution is unique-only: because `stableId` is name+parameter-shape (a
   * homonym — a genuinely different symbol with the same name and signature —
   * shares it), the resolver returns a node only when exactly one carries the id,
   * never guessing between candidates. A residual false-`fresh` is still possible
   * if a homonym is the sole survivor AND its span hash happens to equal the
   * recorded one; the content-hash equality check in `anchorFreshness` is the
   * guard that makes any *changed* survivor read `drifted` instead. During an
   * incremental cross-file move the old and new rows can briefly both carry the id
   * (ambiguous → `undefined` → falls through to `orphaned`); the state self-heals
   * once the batch finishes and is corrected by the next full analyze.
   */
  resolveStableId?(stableId: string): { nodeId: string; contentHash: string } | undefined;
  /**
   * Confident rename mapping: given an absent node id, the new location label
   * (e.g. `newFile.ts::newName`) when `structural_diff` mapped it, else undefined.
   * Optional — when absent, a missing symbol is always `orphaned`.
   */
  renameOf?(nodeId: string): string | undefined;
}

/**
 * Resolve symbol names to symbol-level anchors deterministically. A name resolves
 * only when it matches exactly one internal node — optionally narrowed to the
 * given `preferFiles` first. Ambiguous or unknown names are skipped (no guessing);
 * callers fall back to file-level anchoring for those.
 */
export function resolveSymbolAnchors(
  symbolNames: readonly string[],
  nodes: readonly AnchorNode[],
  preferFiles?: readonly string[],
): StructuralAnchor[] {
  const out: StructuralAnchor[] = [];
  const seen = new Set<string>();
  const prefer = preferFiles ? new Set(preferFiles) : null;

  for (const name of new Set(symbolNames)) {
    let matches = nodes.filter((n) => n.name === name);
    if (prefer && matches.length > 1) {
      const narrowed = matches.filter((n) => prefer.has(n.filePath));
      if (narrowed.length >= 1) matches = narrowed;
    }
    if (matches.length !== 1) continue; // unknown or ambiguous — do not guess
    const node = matches[0];
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push({
      nodeId: node.id,
      ...(node.stableId ? { stableId: node.stableId } : {}),
      symbolName: node.name,
      filePath: node.filePath,
      contentHash: node.contentHash,
    });
  }
  return out;
}

/** Build a file-level anchor, capturing the file content hash when available. */
export function fileAnchor(filePath: string, contentHash?: string): StructuralAnchor {
  return contentHash === undefined ? { filePath } : { filePath, contentHash };
}

/**
 * Compute the freshness verdict for a single anchor against the current graph.
 * Inputs are booleans only — no threshold, no score.
 */
export function anchorFreshness(
  anchor: StructuralAnchor,
  view: GraphFreshnessView,
): AnchorVerdict {
  // Symbol-level anchor.
  if (anchor.nodeId) {
    const current = view.nodeHash(anchor.nodeId);
    // nodeId takes precedence: a still-resolving node is decided here, never via
    // stableId (add-content-addressed-stable-symbol-ids).
    if (current !== undefined) {
      return { anchor, freshness: current === anchor.contentHash ? 'fresh' : 'drifted' };
    }
    // nodeId miss — the symbol may have moved/renamed-file. Re-resolve by its
    // content-addressed stable id: a relocated-but-unchanged symbol is `fresh`,
    // a relocated-and-changed one is `drifted` — no longer `orphaned`.
    if (anchor.stableId) {
      const relocated = view.resolveStableId?.(anchor.stableId);
      if (relocated) {
        return {
          anchor,
          freshness: relocated.contentHash === anchor.contentHash ? 'fresh' : 'drifted',
          relocatedTo: relocated.nodeId,
        };
      }
    }
    // Last resort — the existing heuristic rename map, then orphaned.
    const relocatedTo = view.renameOf?.(anchor.nodeId);
    return relocatedTo
      ? { anchor, freshness: 'drifted', relocatedTo }
      : { anchor, freshness: 'orphaned' };
  }

  // File-level anchor.
  if (!view.fileExists(anchor.filePath)) {
    return { anchor, freshness: 'orphaned' };
  }
  // A truly legacy anchor has no baseline hash — existence is all we can prove.
  if (anchor.contentHash === undefined) {
    return { anchor, freshness: 'fresh' };
  }
  const current = view.fileHash(anchor.filePath);
  return { anchor, freshness: current === anchor.contentHash ? 'fresh' : 'drifted' };
}

const FRESHNESS_RANK: Record<MemoryFreshness, number> = {
  fresh: 0,
  drifted: 1,
  orphaned: 2,
};

/**
 * A memory's overall verdict is the worst of its anchors' verdicts
 * (orphaned > drifted > fresh). An unanchored memory is `fresh` — there is
 * nothing to invalidate; callers report `anchored: false` separately.
 */
export function aggregateFreshness(verdicts: readonly AnchorVerdict[]): MemoryFreshness {
  let worst: MemoryFreshness = 'fresh';
  for (const v of verdicts) {
    if (FRESHNESS_RANK[v.freshness] > FRESHNESS_RANK[worst]) worst = v.freshness;
  }
  return worst;
}

/** Compute per-anchor verdicts and the aggregate for a whole memory. */
export function memoryFreshness(
  anchors: readonly StructuralAnchor[],
  view: GraphFreshnessView,
): { freshness: MemoryFreshness; verdicts: AnchorVerdict[]; anchored: boolean } {
  const verdicts = anchors.map((a) => anchorFreshness(a, view));
  return {
    freshness: aggregateFreshness(verdicts),
    verdicts,
    anchored: anchors.length > 0,
  };
}

/**
 * The anchors to check freshness against for a decision: its explicit structural
 * anchors when present, otherwise existence-only file-level anchors derived from
 * `affectedFiles` (legacy decisions recorded before anchoring). Shared by recall,
 * orient, and the drift detector so they agree on what a decision is bound to.
 */
export function decisionAnchors(
  d: Pick<PendingDecision, 'anchors' | 'affectedFiles'>,
): StructuralAnchor[] {
  if (d.anchors?.length) return d.anchors;
  return d.affectedFiles.map((filePath) => ({ filePath }));
}

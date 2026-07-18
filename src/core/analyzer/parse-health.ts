/**
 * Parse-health disclosure (change: add-parse-health-boundary-disclosure).
 *
 * The language-support registry can't over-claim a *language* — but it says nothing about failed
 * extraction *inside* a supported language. A file the pinned grammar rejects, a tree tree-sitter
 * recovered with a large `ERROR` region, or a source that decoded lossily today yields a silently
 * smaller graph indistinguishable from "there is genuinely nothing there." This module records
 * per-file parse health so downstream conclusions can disclose *unknown* instead of implying
 * *absent* — the exact failure mode the `NoFalseCompleteness` requirement exists to prevent.
 *
 * Two honesty rules, mirroring the style-fingerprint and IaC extractors:
 *   1. Clean files pay zero: `tallyParseHealth` returns `undefined` unless the parsed tree actually
 *      carries an error, so a healthy repo produces no records and no boundary is ever emitted.
 *   2. The signal is a LOWER BOUND: an ERROR region can swallow well-formed neighbors, so a
 *      disclosed count is "at least this degraded," never "exactly this and no more."
 *
 * Tallied in the SAME per-file AST walk that extracts nodes/edges (no second parse), exactly like
 * the style fingerprint. Deterministic: integer tallies over a deterministic walk, sorted keys, no
 * clock — byte-identical across re-analyses of a fixed repository state.
 */

/** Bump when the persisted artifact shape changes incompatibly. */
export const PARSE_HEALTH_SCHEMA_VERSION = 1;

/**
 * Cap on the number of error-region start lines retained per file. A bound on the persisted record
 * (a pathological file could otherwise carry thousands of ERROR nodes); the counts stay exact, only
 * the line LIST is truncated, and truncation is disclosed (`truncated: true`).
 */
export const PARSE_HEALTH_LINE_CAP = 25;


/**
 * Per-file parse health. Present ONLY for a file with at least one signal (error region, parse
 * failure, or encoding fallback) — a clean file has no record. Absent fields mean "not observed."
 */
export interface FileParseHealth {
  filePath: string;
  language: string;
  /** tree-sitter `ERROR` nodes (unparseable spans the recovery inserted). */
  errorCount: number;
  /** tree-sitter `MISSING` nodes (tokens the grammar expected but the source omitted). */
  missingCount: number;
  /** 1-based start lines of the error/missing regions, sorted + deduped, bounded by the cap. */
  errorLines: number[];
  /** `errorLines` hit the cap — more regions exist than are listed. */
  truncated?: boolean;
  /** The extractor threw or produced no usable tree — the whole file contributed nothing. */
  parseFailed?: boolean;
  /** The source decoded lossily (contained U+FFFD) — parse output may be garbage. */
  encodingFallback?: boolean;
}

/**
 * Minimal structural view of a tree-sitter node. Kept dependency-light (no `tree-sitter` import) so
 * this module stays a leaf, and defensive across binding versions: `ERROR` is detected by `type`
 * (stable across bindings) and `MISSING` by `isMissing` as either a boolean property (node-tree-
 * sitter) or a method (web-tree-sitter). A plain test object supplying only `type`/`children`
 * still works.
 */
export interface ParseHealthNode {
  type: string;
  startPosition: { row: number };
  isMissing?: boolean | (() => boolean);
  hasError?: boolean | (() => boolean);
  children: ParseHealthNode[];
  childCount?: number;
  child?(i: number): ParseHealthNode | null;
}

function coerceBool(v: boolean | (() => boolean) | undefined): boolean {
  return typeof v === 'function' ? !!v() : !!v;
}

/** Does the (sub)tree rooted here carry any error/missing node? Cheap: reads the root's own flag. */
function treeHasError(root: ParseHealthNode): boolean {
  // `hasError` on the ROOT reflects the whole tree in every binding we use. Fall back to a direct
  // ERROR-type check for a test object that omits the flag.
  if (root.hasError !== undefined) return coerceBool(root.hasError);
  return root.type === 'ERROR';
}

function isMissingNode(n: ParseHealthNode): boolean {
  return coerceBool(n.isMissing);
}

/**
 * Record parse health for one file from its already-parsed tree. Returns `undefined` for a clean
 * tree (the fast path — no walk, zero cost, so a healthy repo produces no records). When the tree
 * carries an error it walks ALL children (not just named — an unnamed ERROR token still counts),
 * tallying `ERROR` and `MISSING` nodes and collecting their start lines up to the cap.
 *
 * The walk fires only on the rare error tree, so its `children` allocation is not on the hot path.
 */
export function tallyParseHealth(
  language: string,
  rootNode: ParseHealthNode,
  filePath: string,
): FileParseHealth | undefined {
  if (!treeHasError(rootNode)) return undefined;

  let errorCount = 0;
  let missingCount = 0;
  const lines = new Set<number>();
  let truncated = false;

  const visit = (n: ParseHealthNode): void => {
    let isRegion = false;
    if (n.type === 'ERROR') { errorCount++; isRegion = true; }
    if (isMissingNode(n)) { missingCount++; isRegion = true; }
    if (isRegion) {
      if (lines.size < PARSE_HEALTH_LINE_CAP) lines.add(n.startPosition.row + 1);
      else truncated = true;
    }
    // Prefer allocation-free index accessors (real SyntaxNode); fall back to `.children` (tests).
    if (typeof n.childCount === 'number' && typeof n.child === 'function') {
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c) visit(c);
      }
    } else {
      for (const c of n.children) visit(c);
    }
  };
  visit(rootNode);

  // `hasError` can read true on a tree that carries no actual ERROR/MISSING node (a binding/grammar
  // quirk observed on some grammars for well-formed input). Parse health is a SOUND LOWER BOUND —
  // over-reporting would cry wolf on clean code — so a signal with no confirmed error node is
  // dropped, not fabricated.
  if (errorCount === 0 && missingCount === 0) return undefined;

  return {
    filePath,
    language,
    errorCount,
    missingCount,
    errorLines: [...lines].sort((a, b) => a - b),
    ...(truncated ? { truncated: true } : {}),
  };
}

/**
 * True if decoding these bytes as UTF-8 is LOSSY — the source contains byte sequences that are not
 * valid UTF-8 and would be replaced by U+FFFD. Detected at the BYTE level (a strict decode that
 * throws), NOT by scanning the decoded string for U+FFFD: a file may legitimately CONTAIN U+FFFD
 * (as valid UTF-8 bytes `EF BF BD`), and flagging that would be a false positive. Only genuinely
 * undecodable bytes count.
 */
export function isLossyUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return false;
  } catch {
    return true;
  }
}

/** A file is "degraded" if it carries any parse-health signal at all. */
export function isDegraded(h: FileParseHealth): boolean {
  return h.errorCount > 0 || h.missingCount > 0 || !!h.parseFailed || !!h.encodingFallback;
}

/** One language's rolled-up degradation, for the compact summary. */
export interface ParseHealthLanguageSummary {
  language: string;
  degradedFiles: number;
  errorRegions: number;
  parseFailures: number;
  encodingFallbacks: number;
}

/** The persisted, rolled-up parse-health report (its own `parse-health.json` artifact). */
export interface ParseHealthReport {
  version: number;
  /** Files carrying at least one signal. */
  totalDegradedFiles: number;
  /** Sum of ERROR + MISSING regions across all degraded files. */
  totalErrorRegions: number;
  /** Per-language rollup, sorted by degraded-file count desc then name. */
  byLanguage: ParseHealthLanguageSummary[];
  /** The worst offenders, sorted by region count desc then path, bounded. */
  topFiles: FileParseHealth[];
  /** Every per-file record (the source of truth the watcher splices and consumers scan). */
  files: FileParseHealth[];
}

function regionCount(h: FileParseHealth): number {
  return h.errorCount + h.missingCount;
}

/**
 * Roll the raw per-file records up into the persisted report. Returns `undefined` when there are no
 * records at all — a clean repo persists no artifact and every consumer treats "no artifact" as
 * "nothing degraded," so clean repos pay zero (no boundary, no payload growth).
 */
export function buildParseHealthReport(
  records: FileParseHealth[],
  topN = 10,
): ParseHealthReport | undefined {
  const degraded = records.filter(isDegraded);
  if (degraded.length === 0) return undefined;

  const byLang = new Map<string, ParseHealthLanguageSummary>();
  let totalErrorRegions = 0;
  for (const h of degraded) {
    totalErrorRegions += regionCount(h);
    const s = byLang.get(h.language) ?? {
      language: h.language,
      degradedFiles: 0,
      errorRegions: 0,
      parseFailures: 0,
      encodingFallbacks: 0,
    };
    s.degradedFiles++;
    s.errorRegions += regionCount(h);
    if (h.parseFailed) s.parseFailures++;
    if (h.encodingFallback) s.encodingFallbacks++;
    byLang.set(h.language, s);
  }

  const byLanguage = [...byLang.values()].sort(
    (a, b) => b.degradedFiles - a.degradedFiles || (a.language < b.language ? -1 : 1),
  );
  const sorted = [...degraded].sort(
    (a, b) => regionCount(b) - regionCount(a) || (a.filePath < b.filePath ? -1 : 1),
  );

  return {
    version: PARSE_HEALTH_SCHEMA_VERSION,
    totalDegradedFiles: degraded.length,
    totalErrorRegions,
    byLanguage,
    topFiles: sorted.slice(0, topN),
    files: sorted,
  };
}

/** A compact, one-line-per-language string list for the `orient` summary (bounded upstream). */
export function compactParseHealthSummary(report: ParseHealthReport): string[] {
  return report.byLanguage.map(
    (s) =>
      `${s.language}=${s.degradedFiles} file${s.degradedFiles === 1 ? '' : 's'}` +
      ` (${s.errorRegions} error region${s.errorRegions === 1 ? '' : 's'}` +
      `${s.parseFailures ? `, ${s.parseFailures} parse-failure${s.parseFailures === 1 ? '' : 's'}` : ''}` +
      `${s.encodingFallbacks ? `, ${s.encodingFallbacks} encoding-fallback${s.encodingFallbacks === 1 ? '' : 's'}` : ''})`,
  );
}

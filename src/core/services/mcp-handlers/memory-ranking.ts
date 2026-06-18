/**
 * Deterministic recall ranking. (change: improve-recall-retrieval-ranking)
 *
 * Replaces `recall`'s binary substring token-overlap with a field-weighted,
 * graded, identifier-aware ranker — still 100% deterministic: no LLM, no
 * embedding, no learned model. Two transferable ideas from the agent-memory
 * field survive the determinism constraint (field weighting, identifier-aware
 * normalization); the exact-anchor boost is OpenLore-native — it knows a memory
 * is *about* a specific symbol, a signal a lexical-only ranker lacks.
 *
 * Pure functions only, so the whole ranker is unit-testable in isolation. The
 * weights and stopword set below are fixed, documented constants — not learned,
 * not tuned at runtime, not derived from usage.
 */

/**
 * Fixed scoring weights. A match in a stronger field contributes more than a
 * match in a weaker one (anchor symbol > tags > anchor file path > content).
 */
export const FIELD_WEIGHTS = {
  anchorSymbol: 4,
  tag: 3,
  anchorFile: 2,
  content: 1,
} as const;

/** Strong boost when the query names the exact symbol a memory is anchored to. */
export const ANCHOR_EXACT_BOOST = 8;

/** Graded, but capped so one token repeated many times can't dominate. */
export const OCCURRENCE_CAP = 3;

/**
 * Per-substring contribution of the legacy fallback, applied ONLY when the
 * token-based score is zero. Kept far below the smallest field weight (1) so a
 * real token match always outranks a fallback-only (cross-word substring) match,
 * while guaranteeing the superset property: anything the old substring-overlap
 * matched still surfaces.
 */
export const SUBSTRING_FALLBACK_WEIGHT = 0.1;

/**
 * Small, fixed stopword set: high-frequency words that carry no retrieval
 * signal for code memory. Deliberately short — over-stemming loses recall.
 */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'for', 'is',
  'are', 'was', 'be', 'by', 'as', 'it', 'this', 'that', 'with', 'how', 'does',
  'do', 'what', 'when', 'where', 'why', 'which', 'about', 'into', 'from',
]);

const MIN_TOKEN_LEN = 2;

/**
 * Identifier-aware normalization. Splits camelCase / PascalCase / snake_case /
 * kebab-case into subtokens, lower-cases, drops stopwords and 1-char tokens.
 * Returns tokens WITH multiplicity (callers that want a set dedup themselves) so
 * graded frequency scoring is possible. Pure: no external data, no I/O.
 *
 * Order of operations matters: identifier boundaries (the case transitions) must
 * be split BEFORE lower-casing, or `validateDirectory` collapses to one opaque
 * token and the camelCase boundary is lost.
 */
export function normalizeTokens(raw: string): string[] {
  if (!raw) return [];
  const out: string[] = [];
  // 1. Break on any non-identifier char (covers snake_case, kebab-case, spaces,
  //    punctuation), preserving case for the camelCase split that follows.
  for (const chunk of raw.split(/[^A-Za-z0-9]+/)) {
    if (!chunk) continue;
    // 2. Split camelCase / PascalCase / runs-of-caps (HTTPServer -> HTTP, Server).
    for (const sub of chunk.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      const t = sub.toLowerCase();
      if (t.length >= MIN_TOKEN_LEN && !STOPWORDS.has(t)) out.push(t);
    }
  }
  return out;
}

/** Deduped, normalized query terms. */
export function queryTerms(task: string): string[] {
  return [...new Set(normalizeTokens(task))];
}

/** The four weighted fields a memory is ranked over. */
export interface RankFields {
  /** Resolved anchor symbol names (e.g. `validateDirectory`). */
  anchorSymbols: string[];
  tags: string[];
  /** Anchor / affected file paths. */
  anchorFiles: string[];
  /** Free-text body (note content, or a decision's title + rationale). */
  content: string;
}

export interface RankResult {
  score: number;
  /** Which weighted fields contributed (for transparent ranking reasons). */
  matched: Array<keyof RankFields>;
  /** Whether the query named the exact symbol the memory is anchored to. */
  anchorBoost: boolean;
}

function countOccurrences(terms: string[], fieldTokens: string[]): number {
  if (!fieldTokens.length) return 0;
  const freq = new Map<string, number>();
  for (const tok of fieldTokens) freq.set(tok, (freq.get(tok) ?? 0) + 1);
  let occ = 0;
  for (const term of terms) {
    const c = freq.get(term);
    if (c) occ += Math.min(c, OCCURRENCE_CAP);
  }
  return occ;
}

/**
 * Score a memory's fields against deduped query `terms`. Deterministic.
 *
 * Primary score is field-weighted and graded (token-equality on normalized
 * subtokens). The exact-anchor boost fires when every subtoken of an anchor
 * symbol is present in the query — i.e. the query *names* that symbol. The
 * legacy substring fallback applies only when the primary score is zero, so the
 * candidate set is always a superset of the old substring-overlap behavior.
 */
export function scoreMemory(terms: string[], fields: RankFields): RankResult {
  if (!terms.length) return { score: 0, matched: [], anchorBoost: false };
  const termSet = new Set(terms);

  let score = 0;
  const matched: Array<keyof RankFields> = [];

  const fieldTokenSources: Array<{ key: keyof RankFields; weight: number; tokens: string[] }> = [
    { key: 'anchorSymbols', weight: FIELD_WEIGHTS.anchorSymbol, tokens: fields.anchorSymbols.flatMap(normalizeTokens) },
    { key: 'tags', weight: FIELD_WEIGHTS.tag, tokens: fields.tags.flatMap(normalizeTokens) },
    { key: 'anchorFiles', weight: FIELD_WEIGHTS.anchorFile, tokens: fields.anchorFiles.flatMap(normalizeTokens) },
    { key: 'content', weight: FIELD_WEIGHTS.content, tokens: normalizeTokens(fields.content) },
  ];

  for (const { key, weight, tokens } of fieldTokenSources) {
    const occ = countOccurrences(terms, tokens);
    if (occ > 0) {
      score += weight * occ;
      matched.push(key);
    }
  }

  // Exact-anchor boost: the query names a symbol this memory is anchored to.
  let anchorBoost = false;
  for (const sym of fields.anchorSymbols) {
    const symTokens = normalizeTokens(sym);
    if (symTokens.length && symTokens.every((t) => termSet.has(t))) {
      anchorBoost = true;
      break;
    }
  }
  if (anchorBoost) score += ANCHOR_EXACT_BOOST;

  // Superset guarantee: if nothing matched as a token, fall back to the legacy
  // substring-overlap so a memory the old ranker surfaced is never dropped.
  if (score === 0) {
    const hay = [
      ...fields.anchorSymbols,
      ...fields.tags,
      ...fields.anchorFiles,
      fields.content,
    ].join(' ').toLowerCase();
    let hits = 0;
    for (const term of termSet) if (hay.includes(term)) hits++;
    if (hits > 0) score = SUBSTRING_FALLBACK_WEIGHT * hits;
  }

  return { score, matched, anchorBoost };
}

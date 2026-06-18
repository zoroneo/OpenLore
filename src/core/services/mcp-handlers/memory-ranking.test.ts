/**
 * Unit tests for the deterministic recall ranker.
 * (change: improve-recall-retrieval-ranking)
 *
 * Pure functions, no I/O — guards the mcp-handlers-spec requirements
 * DeterministicRecallRanking and ExactAnchorBoost. Plain .test.ts so CI runs it.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeTokens,
  queryTerms,
  scoreMemory,
  type RankFields,
  ANCHOR_EXACT_BOOST,
  FIELD_WEIGHTS,
} from './memory-ranking.js';

const emptyFields = (over: Partial<RankFields>): RankFields => ({
  anchorSymbols: [],
  tags: [],
  anchorFiles: [],
  content: '',
  ...over,
});

describe('normalizeTokens', () => {
  it('splits camelCase / PascalCase into lowercased subtokens', () => {
    expect(normalizeTokens('validateDirectory')).toEqual(['validate', 'directory']);
    expect(normalizeTokens('HTTPServer')).toEqual(['http', 'server']);
  });

  it('splits snake_case and kebab-case', () => {
    expect(normalizeTokens('write_through_cache')).toEqual(['write', 'through', 'cache']);
    expect(normalizeTokens('read-only-mode')).toEqual(['read', 'only', 'mode']);
  });

  it('drops stopwords and 1-char tokens, keeps multiplicity', () => {
    // "is"/"a"/"the" are stopwords; "x" is too short; "cache" appears twice.
    expect(normalizeTokens('the cache is a x cache')).toEqual(['cache', 'cache']);
  });

  it('returns [] for empty / punctuation-only input', () => {
    expect(normalizeTokens('')).toEqual([]);
    expect(normalizeTokens('--- ... ///')).toEqual([]);
  });
});

describe('queryTerms', () => {
  it('dedupes normalized terms', () => {
    expect(queryTerms('cache the cache writeThrough').sort()).toEqual(['cache', 'through', 'write']);
  });
});

describe('scoreMemory — field weighting', () => {
  it('an anchor-symbol match outranks a content-only match for the same term', () => {
    const symHit = scoreMemory(['parse'], emptyFields({ anchorSymbols: ['parseConfig'] }));
    const contentHit = scoreMemory(['parse'], emptyFields({ content: 'we parse things here' }));
    expect(symHit.score).toBeGreaterThan(contentHit.score);
    expect(symHit.matched).toContain('anchorSymbols');
    expect(contentHit.matched).toContain('content');
  });

  it('respects the documented field-weight ordering symbol > tag > file > content', () => {
    const s = (f: Partial<RankFields>) => scoreMemory(['cache'], emptyFields(f)).score;
    const sym = s({ anchorSymbols: ['cache'] });
    const tag = s({ tags: ['cache'] });
    const file = s({ anchorFiles: ['cache.ts'] });
    const content = s({ content: 'cache' });
    expect(sym).toBeGreaterThan(tag);
    expect(tag).toBeGreaterThan(file);
    expect(file).toBeGreaterThan(content);
    expect(content).toBe(FIELD_WEIGHTS.content);
  });

  it('is graded: a repeated token outscores a single occurrence (up to the cap)', () => {
    const once = scoreMemory(['cache'], emptyFields({ content: 'cache' }));
    const thrice = scoreMemory(['cache'], emptyFields({ content: 'cache cache cache' }));
    expect(thrice.score).toBeGreaterThan(once.score);
  });
});

describe('scoreMemory — exact-anchor boost', () => {
  it('boosts when every subtoken of an anchor symbol is named by the query', () => {
    const boosted = scoreMemory(queryTerms('how does validateDirectory work'),
      emptyFields({ anchorSymbols: ['validateDirectory'] }));
    const notBoosted = scoreMemory(queryTerms('validate something else'),
      emptyFields({ anchorSymbols: ['validateDirectory'] }));
    expect(boosted.anchorBoost).toBe(true);
    expect(notBoosted.anchorBoost).toBe(false);
    expect(boosted.score).toBeGreaterThanOrEqual(ANCHOR_EXACT_BOOST);
  });

  it('a memory about the named symbol outranks a prose-only mention', () => {
    const about = scoreMemory(queryTerms('validateDirectory'),
      emptyFields({ anchorSymbols: ['validateDirectory'], content: 'guards the path' }));
    const mention = scoreMemory(queryTerms('validateDirectory'),
      emptyFields({ content: 'we call validateDirectory somewhere' }));
    expect(about.score).toBeGreaterThan(mention.score);
  });
});

describe('scoreMemory — superset guarantee & edge cases', () => {
  it('empty query scores zero', () => {
    expect(scoreMemory([], emptyFields({ content: 'anything' })).score).toBe(0);
  });

  it('a cross-word substring the old ranker matched still surfaces (score > 0)', () => {
    // Old behavior: includes("parse") true for "reparser"; tokenization would miss it.
    const r = scoreMemory(['parse'], emptyFields({ content: 'reparser internals' }));
    expect(r.score).toBeGreaterThan(0);
  });

  it('a real token match always outranks a fallback-only substring match', () => {
    const tokenMatch = scoreMemory(['parse'], emptyFields({ content: 'we parse it' }));
    const fallbackOnly = scoreMemory(['parse'], emptyFields({ content: 'reparser internals' }));
    expect(tokenMatch.score).toBeGreaterThan(fallbackOnly.score);
  });
});

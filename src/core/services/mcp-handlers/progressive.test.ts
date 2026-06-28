/**
 * Spec 25 Phase C — progressive-disclosure helpers (P2–P4).
 */
import { describe, it, expect } from 'vitest';
import { expandHandle, applyTokenBudget, collapseExactDuplicates, omissionNote, normalizeResponseFormat, truncationReceipt } from './progressive.js';

describe('expandHandle (P2)', () => {
  it('formats a deterministic name::filePath handle', () => {
    expect(expandHandle('readConfig', 'src/config.ts')).toBe('readConfig::src/config.ts');
  });
});

describe('applyTokenBudget (P4)', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}`, blob: 'x'.repeat(200) }));

  it('returns everything when no budget is set', () => {
    expect(applyTokenBudget(items, undefined)).toEqual({ kept: items, omitted: 0 });
    expect(applyTokenBudget(items, 0)).toEqual({ kept: items, omitted: 0 });
  });

  it('keeps a score-ordered prefix that fits and reports the omitted count', () => {
    const out = applyTokenBudget(items, 120); // each item ~50 tokens → a few fit
    expect(out.kept.length).toBeGreaterThan(0);
    expect(out.kept.length).toBeLessThan(items.length);
    expect(out.omitted).toBe(items.length - out.kept.length);
    expect(out.kept).toEqual(items.slice(0, out.kept.length)); // prefix, order preserved
  });

  it('always keeps at least one item even under a tiny budget', () => {
    expect(applyTokenBudget(items, 1).kept).toHaveLength(1);
  });

  it('is deterministic (same input + budget → same output)', () => {
    expect(applyTokenBudget(items, 120)).toEqual(applyTokenBudget(items, 120));
  });
});

describe('collapseExactDuplicates (P3)', () => {
  it('collapses same name+signature+docstring across files into one exemplar', () => {
    const out = collapseExactDuplicates([
      { name: 'h', filePath: 'a.ts', signature: 'h()', docstring: 'd' },
      { name: 'h', filePath: 'b.ts', signature: 'h()', docstring: 'd' },
      { name: 'h', filePath: 'c.ts', signature: 'h()', docstring: 'd' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].filePath).toBe('a.ts');
    expect(out[0].duplicateOf).toEqual(['b.ts', 'c.ts']);
  });

  it('does NOT merge functions that merely share a name (different signature)', () => {
    const out = collapseExactDuplicates([
      { name: 'h', filePath: 'a.ts', signature: 'h(x)' },
      { name: 'h', filePath: 'b.ts', signature: 'h(x, y)' },
    ]);
    expect(out).toHaveLength(2);
    expect(out.every(o => o.duplicateOf === undefined)).toBe(true);
  });

  it('preserves order', () => {
    const out = collapseExactDuplicates([
      { name: 'a', filePath: 'a.ts', signature: 's1' },
      { name: 'b', filePath: 'b.ts', signature: 's2' },
    ]);
    expect(out.map(o => o.name)).toEqual(['a', 'b']);
  });
});

describe('omissionNote', () => {
  it('states the count and the expansion hint', () => {
    expect(omissionNote(3, 'raise tokenBudget')).toBe('3 more result(s) omitted to fit tokenBudget — raise tokenBudget');
  });
});

describe('normalizeResponseFormat (ConciseByDefaultDetailedOnRequest)', () => {
  it('returns "detailed" only for the exact string, else concise', () => {
    expect(normalizeResponseFormat('detailed')).toBe('detailed');
    expect(normalizeResponseFormat('concise')).toBe('concise');
    expect(normalizeResponseFormat(undefined)).toBe('concise');
    expect(normalizeResponseFormat('verbose')).toBe('concise');
    expect(normalizeResponseFormat(null)).toBe('concise');
  });
});

describe('truncationReceipt', () => {
  it('returns a receipt when items were omitted, null otherwise', () => {
    expect(truncationReceipt(5, 'ask for more')).toEqual({ omitted: 5, detail: 'ask for more' });
    expect(truncationReceipt(0, 'ask for more')).toBeNull();
  });
});

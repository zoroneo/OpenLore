/**
 * Code-anchored memory engine — deterministic resolution + freshness.
 * (change: add-code-anchored-memory-staleness)
 *
 * Plain .test.ts so CI runs it: these guard the analyzer-spec requirements
 * StructuralMemoryAnchor / DeterministicMemoryFreshness / FileLevelFreshness.
 */
import { describe, it, expect } from 'vitest';
import {
  hashSpan,
  resolveSymbolAnchors,
  fileAnchor,
  anchorFreshness,
  aggregateFreshness,
  memoryFreshness,
  decisionAnchors,
  type AnchorNode,
  type GraphFreshnessView,
} from './anchor.js';
import type { StructuralAnchor } from '../../types/index.js';

const node = (id: string, name: string, filePath: string, contentHash: string): AnchorNode =>
  ({ id, name, filePath, contentHash });

/** A view backed by simple maps; absent node id => gone, absent file => missing. */
function viewFrom(opts: {
  nodes?: Record<string, string>; // nodeId -> current hash
  files?: Record<string, string | null>; // filePath -> current hash (null = exists, unknown hash)
  renames?: Record<string, string>;
}): GraphFreshnessView {
  return {
    nodeHash: (id) => opts.nodes?.[id],
    fileExists: (f) => opts.files !== undefined && f in opts.files,
    fileHash: (f) => opts.files?.[f] ?? undefined,
    renameOf: (id) => opts.renames?.[id],
  };
}

describe('hashSpan', () => {
  it('is reproducible for identical input and differs for changed input', () => {
    expect(hashSpan('function f() { return 1 }')).toBe(hashSpan('function f() { return 1 }'));
    expect(hashSpan('function f() { return 1 }')).not.toBe(hashSpan('function f() { return 2 }'));
  });
});

describe('resolveSymbolAnchors', () => {
  const nodes = [
    node('a.ts::foo', 'foo', 'a.ts', 'h1'),
    node('b.ts::foo', 'foo', 'b.ts', 'h2'),
    node('a.ts::bar', 'bar', 'a.ts', 'h3'),
  ];

  it('resolves a unique symbol to a symbol-level anchor with its content hash', () => {
    const anchors = resolveSymbolAnchors(['bar'], nodes);
    expect(anchors).toEqual([{ nodeId: 'a.ts::bar', symbolName: 'bar', filePath: 'a.ts', contentHash: 'h3' }]);
  });

  it('skips an unknown symbol (no guessing)', () => {
    expect(resolveSymbolAnchors(['nope'], nodes)).toEqual([]);
  });

  it('skips an ambiguous symbol when nothing narrows it', () => {
    expect(resolveSymbolAnchors(['foo'], nodes)).toEqual([]);
  });

  it('narrows an ambiguous symbol by preferred files', () => {
    const anchors = resolveSymbolAnchors(['foo'], nodes, ['b.ts']);
    expect(anchors).toEqual([{ nodeId: 'b.ts::foo', symbolName: 'foo', filePath: 'b.ts', contentHash: 'h2' }]);
  });
});

describe('anchorFreshness — symbol-level', () => {
  const anchor: StructuralAnchor = { nodeId: 'a.ts::foo', symbolName: 'foo', filePath: 'a.ts', contentHash: 'h1' };

  it('fresh when the symbol exists and its hash is unchanged', () => {
    expect(anchorFreshness(anchor, viewFrom({ nodes: { 'a.ts::foo': 'h1' } })).freshness).toBe('fresh');
  });

  it('drifted when the symbol exists but its hash changed', () => {
    expect(anchorFreshness(anchor, viewFrom({ nodes: { 'a.ts::foo': 'h9' } })).freshness).toBe('drifted');
  });

  it('orphaned when the symbol no longer exists', () => {
    expect(anchorFreshness(anchor, viewFrom({ nodes: {} })).freshness).toBe('orphaned');
  });

  it('downgrades orphaned to drifted with a location on a confident rename', () => {
    const v = anchorFreshness(anchor, viewFrom({ nodes: {}, renames: { 'a.ts::foo': 'a.ts::renamedFoo' } }));
    expect(v.freshness).toBe('drifted');
    expect(v.relocatedTo).toBe('a.ts::renamedFoo');
  });
});

describe('anchorFreshness — file-level', () => {
  it('orphaned when the file is gone', () => {
    const a = fileAnchor('gone.ts', 'fh1');
    expect(anchorFreshness(a, viewFrom({ files: {} })).freshness).toBe('orphaned');
  });

  it('drifted when the file content hash changed', () => {
    const a = fileAnchor('x.ts', 'fh1');
    expect(anchorFreshness(a, viewFrom({ files: { 'x.ts': 'fh2' } })).freshness).toBe('drifted');
  });

  it('fresh when the file content hash is unchanged', () => {
    const a = fileAnchor('x.ts', 'fh1');
    expect(anchorFreshness(a, viewFrom({ files: { 'x.ts': 'fh1' } })).freshness).toBe('fresh');
  });

  it('legacy anchor with no baseline hash is fresh while the file exists, orphaned when gone', () => {
    const legacy = fileAnchor('x.ts'); // no contentHash
    expect(anchorFreshness(legacy, viewFrom({ files: { 'x.ts': 'whatever' } })).freshness).toBe('fresh');
    expect(anchorFreshness(legacy, viewFrom({ files: {} })).freshness).toBe('orphaned');
  });
});

describe('aggregateFreshness + memoryFreshness', () => {
  it('takes the worst verdict across anchors', () => {
    expect(aggregateFreshness([
      { anchor: { filePath: 'a' }, freshness: 'fresh' },
      { anchor: { filePath: 'b' }, freshness: 'orphaned' },
    ])).toBe('orphaned');
    expect(aggregateFreshness([
      { anchor: { filePath: 'a' }, freshness: 'fresh' },
      { anchor: { filePath: 'b' }, freshness: 'drifted' },
    ])).toBe('drifted');
  });

  it('reports anchored:false and fresh for an unanchored memory', () => {
    const f = memoryFreshness([], viewFrom({}));
    expect(f.anchored).toBe(false);
    expect(f.freshness).toBe('fresh');
  });

  it('computes per-anchor verdicts and the aggregate together', () => {
    const anchors: StructuralAnchor[] = [
      { nodeId: 'a.ts::foo', filePath: 'a.ts', contentHash: 'h1' },
      { filePath: 'b.ts', contentHash: 'fh1' },
    ];
    const f = memoryFreshness(anchors, viewFrom({ nodes: { 'a.ts::foo': 'h1' }, files: { 'b.ts': 'fh2' } }));
    expect(f.anchored).toBe(true);
    expect(f.verdicts.map((v) => v.freshness)).toEqual(['fresh', 'drifted']);
    expect(f.freshness).toBe('drifted');
  });
});

describe('determinism & adversarial inputs', () => {
  const anchor: StructuralAnchor = { nodeId: 'a.ts::foo', filePath: 'a.ts', contentHash: 'h1' };

  it('produces the same verdict on repeated evaluation (replayable)', () => {
    const view = viewFrom({ nodes: { 'a.ts::foo': 'h9' } });
    const a = anchorFreshness(anchor, view).freshness;
    const b = anchorFreshness(anchor, view).freshness;
    expect(a).toBe(b);
    expect(a).toBe('drifted');
  });

  it('hashes unicode/multibyte content reproducibly and distinctly', () => {
    const a = hashSpan('const s = "café — 日本語 🚀"');
    const b = hashSpan('const s = "café — 日本語 🚀"');
    const c = hashSpan('const s = "cafe — 日本語 🚀"');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('resolveSymbolAnchors dedups repeated names and ignores empty input', () => {
    const nodes = [node('a.ts::foo', 'foo', 'a.ts', 'h1')];
    expect(resolveSymbolAnchors([], nodes)).toEqual([]);
    expect(resolveSymbolAnchors(['foo', 'foo', 'foo'], nodes)).toHaveLength(1);
  });

  it('symbol anchor verdict ignores file-level fields (file changes do not drift a symbol anchor)', () => {
    // The symbol still exists with the same span hash; an unrelated edit elsewhere
    // in the file must NOT mark the symbol-anchored memory drifted.
    const view = viewFrom({ nodes: { 'a.ts::foo': 'h1' }, files: { 'a.ts': 'different-file-hash' } });
    expect(anchorFreshness(anchor, view).freshness).toBe('fresh');
  });
});

describe('decisionAnchors', () => {
  it('returns explicit anchors when present', () => {
    const anchors: StructuralAnchor[] = [{ nodeId: 'a.ts::foo', filePath: 'a.ts', contentHash: 'h1' }];
    expect(decisionAnchors({ anchors, affectedFiles: ['ignored.ts'] })).toBe(anchors);
  });

  it('falls back to existence-only file anchors from affectedFiles (legacy)', () => {
    expect(decisionAnchors({ affectedFiles: ['a.ts', 'b.ts'] })).toEqual([
      { filePath: 'a.ts' },
      { filePath: 'b.ts' },
    ]);
  });

  it('returns no anchors for a decision with neither anchors nor affectedFiles', () => {
    expect(decisionAnchors({ affectedFiles: [] })).toEqual([]);
  });
});

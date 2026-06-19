/**
 * Adversarial freshness suite (change: harden-memory-integrity-invariant).
 *
 * Guards the mcp-handlers-spec requirement FreshnessFailsSafeTowardDistrust. The
 * danger of a content-addressed memory system is the *false-fresh*: a memory
 * served as grounded after the code beneath it changed. This suite fuzzes the
 * address derivation (`hashSpan`) and the verdict engine (`anchorFreshness`) with
 * the edits that actually break anchoring in the field — rename / move / delete,
 * whitespace- and comment-only edits, multibyte UTF-8 span boundaries, and a
 * truncated-hash collision attempt.
 *
 * Governing assertion across the whole file: **a false-`fresh` is a correctness
 * failure; a false-`orphaned`/`drifted` is acceptable.** Fail safe toward distrust.
 *
 * Plain .test.ts so CI runs it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hashSpan,
  anchorFreshness,
  type GraphFreshnessView,
} from './anchor.js';
import { makeFreshnessView, AnchorContext } from './anchor-adapter.js';
import { EdgeStore } from '../services/edge-store.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR } from '../../constants.js';
import type { StructuralAnchor } from '../../types/index.js';
import { CallGraphBuilder, type FunctionNode } from '../analyzer/call-graph.js';

// ── deterministic PRNG (no new dependency; replayable across runs) ────────────
// mulberry32: a tiny seeded generator so the property cases are reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CHARSET =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 \t\n(){}[];=+-*/"\'.café日本語🚀—';
const CHARS = [...CHARSET]; // code-point split so multibyte chars stay intact

function randomSpan(rand: () => number, minLen = 1, maxLen = 80): string {
  const len = minLen + Math.floor(rand() * (maxLen - minLen + 1));
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(rand() * CHARS.length)];
  return s;
}

// ── pure-engine view helpers ──────────────────────────────────────────────────
function viewFrom(opts: {
  nodes?: Record<string, string>;
  files?: Record<string, string | null>;
  renames?: Record<string, string>;
  stableIds?: Record<string, { nodeId: string; contentHash: string }>;
}): GraphFreshnessView {
  return {
    nodeHash: (id) => opts.nodes?.[id],
    fileExists: (f) => opts.files !== undefined && f in opts.files,
    fileHash: (f) => opts.files?.[f] ?? undefined,
    renameOf: (id) => opts.renames?.[id],
    resolveStableId: (sid) => opts.stableIds?.[sid],
  };
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Rename vs. move-across-file vs. delete — each must yield `orphaned`
// ════════════════════════════════════════════════════════════════════════════
describe('FreshnessFailsSafeTowardDistrust — rename / move / delete', () => {
  const anchor: StructuralAnchor = {
    nodeId: 'a.ts::foo',
    stableId: 'sid:foo()',
    symbolName: 'foo',
    filePath: 'a.ts',
    contentHash: 'h1',
  };

  it('a deleted symbol (no relocation evidence) is orphaned, never fresh', () => {
    // Symbol id gone, no stable-id survivor, no rename map.
    const v = anchorFreshness(anchor, viewFrom({ nodes: {}, files: { 'a.ts': 'fh' } }));
    expect(v.freshness).toBe('orphaned');
  });

  it('a renamed symbol (new name, no surviving stable id) is orphaned, never fresh', () => {
    // The old id no longer resolves and the stable id (name+shape) no longer
    // matches any node because the name changed — orphaned, not a false fresh.
    const v = anchorFreshness(anchor, viewFrom({ nodes: {}, stableIds: {}, files: { 'a.ts': 'fh' } }));
    expect(v.freshness).toBe('orphaned');
  });

  it('a symbol moved across files but changed is drifted, never fresh', () => {
    // stable id resolves to the relocated node, but its span hash differs.
    const v = anchorFreshness(
      anchor,
      viewFrom({ nodes: {}, stableIds: { 'sid:foo()': { nodeId: 'b.ts::foo', contentHash: 'DIFFERENT' } } }),
    );
    expect(v.freshness).toBe('drifted');
    expect(v.freshness).not.toBe('fresh');
  });

  it('a symbol moved across files and unchanged is fresh (the only fresh path) — relocation is explicit', () => {
    const v = anchorFreshness(
      anchor,
      viewFrom({ nodes: {}, stableIds: { 'sid:foo()': { nodeId: 'b.ts::foo', contentHash: 'h1' } } }),
    );
    expect(v.freshness).toBe('fresh');
    expect(v.relocatedTo).toBe('b.ts::foo'); // never silently — the move is reported
  });

  it('an ambiguous stable id (homonym collision) resolves to nothing → orphaned, never a guessed fresh', () => {
    // The adapter returns undefined when more than one node carries the stable id
    // (unique-only resolution). Model that as a missing resolution → orphaned.
    const v = anchorFreshness(anchor, viewFrom({ nodes: {}, stableIds: {} }));
    expect(v.freshness).toBe('orphaned');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Whitespace-only and comment-only edits inside an anchored span
//    Documented verdict: DRIFTED. hashSpan is over raw, unnormalized bytes, so
//    any edit inside the span — even a reformat or a comment — is a real change.
//    This is intentional: fail safe toward distrust rather than guess that a
//    reformat "doesn't count."
// ════════════════════════════════════════════════════════════════════════════
describe('FreshnessFailsSafeTowardDistrust — whitespace / comment-only edits drift', () => {
  it('whitespace-only reformat changes the span hash (→ drifted, not fresh)', () => {
    const before = 'function f(){return 1}';
    const after = 'function f() {\n  return 1;\n}';
    expect(hashSpan(after)).not.toBe(hashSpan(before));
  });

  it('comment-only insertion changes the span hash (→ drifted, not fresh)', () => {
    const before = 'function f() { return 1; }';
    const after = 'function f() { /* note */ return 1; }';
    expect(hashSpan(after)).not.toBe(hashSpan(before));
  });

  it('a span with a whitespace-only edit reads drifted through the engine, never fresh', () => {
    const anchor: StructuralAnchor = { nodeId: 'a.ts::f', filePath: 'a.ts', contentHash: hashSpan('function f(){return 1}') };
    const v = anchorFreshness(anchor, viewFrom({ nodes: { 'a.ts::f': hashSpan('function f() { return 1 }') } }));
    expect(v.freshness).toBe('drifted');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Multibyte / UTF-8 span boundaries — span slicing aligned end to end
// ════════════════════════════════════════════════════════════════════════════
// tree-sitter node offsets (startIndex/endIndex) are UTF-16 code-unit indices,
// NOT byte offsets. The anchor adapter must slice the source string by those
// code units — slicing a Buffer by them drifts in any file with multibyte chars
// before the span, citing a misaligned hash + line range. These tests derive the
// node from the REAL parser (ground truth on the offset unit) rather than
// hand-computed offsets, so they fail if the slicing unit ever regresses.
describe('FreshnessFailsSafeTowardDistrust — multibyte span boundaries', () => {
  let root: string;
  let fooNode: FunctionNode;
  const ANALYSIS = () => join(root, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);

  // Source whose lines BEFORE the function contain multibyte chars, so a node
  // offset interpreted as a byte index would land mid-span. `foo`'s body also
  // carries a multibyte literal so an end-offset slip corrupts the span too.
  const SRC = 'const banner = "préface 日本語 🚀";\nexport function foo() {\n  return "café";\n}\n';

  // The exact source a correct citation must reconstruct (the function_declaration
  // node, which begins at `function` — the `export` modifier is its parent).
  const FOO_SRC = SRC.slice(SRC.indexOf('function foo'), SRC.indexOf('}') + 1);

  async function buildStore(): Promise<FunctionNode> {
    const result = await new CallGraphBuilder().build([
      { path: 'src/foo.ts', content: SRC, language: 'TypeScript' },
    ]);
    const node = [...result.nodes.values()].find(n => n.name === 'foo');
    if (!node) throw new Error('parser did not produce a node for foo');
    await mkdir(ANALYSIS(), { recursive: true });
    const store = EdgeStore.open(EdgeStore.dbPath(ANALYSIS()));
    store.clearAll();
    store.insertNodes([node]);
    store.close();
    return node;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'openlore-mb-'));
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'foo.ts'), SRC, 'utf-8');
    fooNode = await buildStore();
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  // Reconstruct the span exactly as the adapter does: slice the string by the
  // real (code-unit) offsets. Byte-slicing here would drift past the leading
  // multibyte line and never reproduce FOO_SRC.
  function spanHashOfCurrent(): string {
    return hashSpan(SRC.slice(fooNode.startIndex, fooNode.endIndex));
  }

  it('node offsets are code units, and the cited span reconstructs the exact function source', () => {
    expect(SRC.slice(fooNode.startIndex, fooNode.endIndex)).toBe(FOO_SRC);
  });

  it('the certificate cites the right line range + a hash of the real span (not byte-misaligned)', () => {
    const ctx = AnchorContext.open(root)!;
    try {
      const cert = ctx.certificateForAnchor({ nodeId: fooNode.id, filePath: 'src/foo.ts', symbolName: 'foo' });
      expect(cert).toBeDefined();
      // foo's declaration is on line 2; its closing brace on line 4.
      expect(cert!.lineSpan).toEqual({ start: 2, end: 4 });
      expect(cert!.contentHash).toBe(hashSpan(FOO_SRC));
    } finally {
      ctx.close();
    }
  });

  it('the freshness view hashes the span correctly (fresh only when the span is unchanged)', () => {
    const store = EdgeStore.open(EdgeStore.dbPath(ANALYSIS()));
    try {
      const view = makeFreshnessView(store, root);
      const anchor: StructuralAnchor = { nodeId: fooNode.id, filePath: 'src/foo.ts', contentHash: spanHashOfCurrent() };
      // Unchanged source → fresh, proving the code-unit slice reconstructs the
      // exact span across a multibyte boundary (no off-by-one corruption).
      expect(anchorFreshness(anchor, view).freshness).toBe('fresh');
    } finally {
      store.close();
    }
  });

  it('changing a multibyte char inside the span drifts (never a false fresh)', async () => {
    const recorded = spanHashOfCurrent();
    // Swap the in-body multibyte string for a different one of a different byte length.
    await writeFile(join(root, 'src', 'foo.ts'), SRC.replace('café', 'thé'), 'utf-8');
    const store = EdgeStore.open(EdgeStore.dbPath(ANALYSIS()));
    try {
      const view = makeFreshnessView(store, root);
      const anchor: StructuralAnchor = { nodeId: fooNode.id, filePath: 'src/foo.ts', contentHash: recorded };
      expect(anchorFreshness(anchor, view).freshness).toBe('drifted');
    } finally {
      store.close();
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Truncated 16-char hash — collision behavior must never produce false fresh
// ════════════════════════════════════════════════════════════════════════════
describe('FreshnessFailsSafeTowardDistrust — truncated hash & collision', () => {
  it('hashSpan emits exactly 16 hex chars (the truncation the engine compares)', () => {
    for (const s of ['', 'x', 'function f(){}', 'café 日本語 🚀']) {
      expect(hashSpan(s)).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it('a single-byte change flips the hash → drifted, never fresh (exact-equality only)', () => {
    const rand = rng(0xC0FFEE);
    for (let i = 0; i < 2000; i++) {
      const span = randomSpan(rand, 4, 60);
      const idx = Math.floor(rand() * span.length);
      const mutated = span.slice(0, idx) + (span[idx] === 'z' ? 'y' : 'z') + span.slice(idx + 1);
      if (mutated === span) continue;
      // Anchor recorded against `span`; current code is `mutated`.
      const anchor: StructuralAnchor = { nodeId: 'n', filePath: 'f', contentHash: hashSpan(span) };
      const v = anchorFreshness(anchor, viewFrom({ nodes: { n: hashSpan(mutated) } }));
      // The ONLY way this is `fresh` is a truncated-hash collision. Treated as a
      // correctness failure if it ever happens.
      expect(v.freshness, `false-fresh on mutation of ${JSON.stringify(span)}`).not.toBe('fresh');
    }
  });

  it('PROPERTY: distinct generated spans never collide on the truncated 16-char hash', () => {
    // This is the collision guard the verdict's trust rests on: the engine reads
    // `fresh` iff the truncated hashes are equal, so if two distinct spans ever
    // truncate-collide a false-fresh becomes reachable. Across a large corpus we
    // assert that does not happen — and the suite fails loudly if it ever does.
    const rand = rng(0x5EED);
    const seen = new Map<string, string>();
    for (let i = 0; i < 20000; i++) {
      const span = randomSpan(rand, 1, 100);
      const h = hashSpan(span);
      const prior = seen.get(h);
      if (prior !== undefined && prior !== span) {
        throw new Error(`truncated-hash collision: ${JSON.stringify(prior)} vs ${JSON.stringify(span)} → ${h}`);
      }
      seen.set(h, span);
    }
    expect(seen.size).toBeGreaterThan(0);
  });

  it('a forced collision (current hash forced equal to a changed span) is the documented trust boundary', () => {
    // anchorFreshness delegates trust entirely to hashSpan equality. If a view
    // were to report the recorded hash for genuinely-different content, the engine
    // would read it as fresh — this is the boundary the collision-freedom property
    // above guards. We assert the delegation is exact (no fuzzy/prefix match): a
    // hash that differs in even its last nibble is NOT fresh.
    const recorded = hashSpan('the original span');
    const offByOneNibble = recorded.slice(0, -1) + (recorded.endsWith('0') ? '1' : '0');
    const anchor: StructuralAnchor = { nodeId: 'n', filePath: 'f', contentHash: recorded };
    expect(anchorFreshness(anchor, viewFrom({ nodes: { n: offByOneNibble } })).freshness).toBe('drifted');
  });
});

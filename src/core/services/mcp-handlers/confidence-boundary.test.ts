/**
 * Confidence-boundary disclosure (change: add-confidence-boundary-disclosure).
 * Unit tests for the deterministic boundary computation: edge basis, synthesized
 * crossings, the no-false-completeness flag, and index staleness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  edgeBasis,
  edgeBasisWithinSet,
  buildPairEdgeIndex,
  edgeBasisForChains,
  crossingsFromBasis,
  assembleBoundary,
  buildStalenessMarker,
  computeStaleness,
  __resetStalenessMemo,
  type BoundaryEdge,
} from './confidence-boundary.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT } from '../../../constants.js';

describe('edgeBasis', () => {
  it('counts a directly-resolved-only traversal as a clean basis', () => {
    const edges: BoundaryEdge[] = [{ confidence: 'import' }, { confidence: 'same_file' }];
    const b = edgeBasis(edges);
    expect(b.directEdges).toBe(2);
    expect(b.synthesizedEdges).toBe(0);
    expect(b.synthesizedByRule).toBeUndefined();
  });

  it('groups synthesized edges by their rule', () => {
    const edges: BoundaryEdge[] = [
      { confidence: 'import' },
      { confidence: 'synthesized', synthesizedBy: 'route-handler' },
      { confidence: 'synthesized', synthesizedBy: 'route-handler' },
      { confidence: 'synthesized', synthesizedBy: 'cha-name-only' },
    ];
    const b = edgeBasis(edges);
    expect(b.directEdges).toBe(1);
    expect(b.synthesizedEdges).toBe(3);
    expect(b.synthesizedByRule).toEqual({ 'route-handler': 2, 'cha-name-only': 1 });
  });

  it('labels a synthesized edge with no rule as "synthesized"', () => {
    const b = edgeBasis([{ confidence: 'synthesized' }]);
    expect(b.synthesizedByRule).toEqual({ synthesized: 1 });
  });
});

describe('edgeBasisWithinSet', () => {
  it('only counts edges whose both endpoints are in the set', () => {
    const edges = [
      { callerId: 'a', calleeId: 'b', confidence: 'import' },
      { callerId: 'b', calleeId: 'c', confidence: 'synthesized', synthesizedBy: 'event-channel' },
      { callerId: 'a', calleeId: 'z', confidence: 'import' }, // z not in set → ignored
    ];
    const b = edgeBasisWithinSet(edges, new Set(['a', 'b', 'c']));
    expect(b.directEdges).toBe(1);
    expect(b.synthesizedEdges).toBe(1);
    expect(b.synthesizedByRule).toEqual({ 'event-channel': 1 });
  });
});

describe('buildPairEdgeIndex + edgeBasisForChains', () => {
  it('prefers a direct edge when a pair has both direct and synthesized edges', () => {
    const idx = buildPairEdgeIndex([
      { callerId: 'a', calleeId: 'b', confidence: 'synthesized', synthesizedBy: 'route-handler' },
      { callerId: 'a', calleeId: 'b', confidence: 'import' },
    ]);
    const b = edgeBasisForChains([['a', 'b']], idx);
    expect(b.directEdges).toBe(1);
    expect(b.synthesizedEdges).toBe(0);
  });

  it('reports a synthesized crossing when it is the only edge for the pair', () => {
    const idx = buildPairEdgeIndex([
      { callerId: 'a', calleeId: 'b', confidence: 'synthesized', synthesizedBy: 'callback-registration' },
    ]);
    const b = edgeBasisForChains([['a', 'b']], idx);
    expect(b.synthesizedEdges).toBe(1);
    expect(b.synthesizedByRule).toEqual({ 'callback-registration': 1 });
  });

  it('dedupes a repeated caller→callee pair across chains', () => {
    const idx = buildPairEdgeIndex([{ callerId: 'a', calleeId: 'b', confidence: 'import' }]);
    const b = edgeBasisForChains([['a', 'b'], ['a', 'b']], idx);
    expect(b.directEdges).toBe(1);
  });
});

describe('crossingsFromBasis', () => {
  it('produces one actionable crossing per synthesized rule, sorted by rule', () => {
    const crossings = crossingsFromBasis({
      directEdges: 1,
      synthesizedEdges: 3,
      synthesizedByRule: { 'route-handler': 2, 'cha-name-only': 1 },
    });
    expect(crossings.map(c => c.rule)).toEqual(['cha-name-only', 'route-handler']);
    expect(crossings[0]).toMatchObject({ kind: 'synthesized-dispatch', rule: 'cha-name-only', count: 1 });
    expect(crossings[1].detail).toContain('route-handler');
    expect(crossings[1].detail).toContain('verify');
  });

  it('returns no crossings for an all-direct basis', () => {
    expect(crossingsFromBasis({ directEdges: 5, synthesizedEdges: 0 })).toEqual([]);
  });
});

describe('assembleBoundary (no-false-completeness)', () => {
  it('marks an all-direct, current-index answer complete', () => {
    const b = assembleBoundary({ basis: { directEdges: 4, synthesizedEdges: 0 } });
    expect(b.complete).toBe(true);
    expect(b.knownUnknowable).toBeUndefined();
    expect(b.staleness).toBeUndefined();
  });

  it('marks a synthesized-reliant answer incomplete and discloses the crossing', () => {
    const b = assembleBoundary({
      basis: { directEdges: 1, synthesizedEdges: 1, synthesizedByRule: { 'route-handler': 1 } },
    });
    expect(b.complete).toBe(false);
    expect(b.knownUnknowable).toHaveLength(1);
    expect(b.knownUnknowable![0].rule).toBe('route-handler');
  });

  it('marks a stale answer incomplete even with an all-direct basis', () => {
    const b = assembleBoundary({
      basis: { directEdges: 3, synthesizedEdges: 0 },
      staleness: { indexCommit: 'abc1234', filesChangedSince: 2, detail: 'stale' },
    });
    expect(b.complete).toBe(false);
    expect(b.staleness?.indexCommit).toBe('abc1234');
  });

  it('appends extra crossings (e.g. an unindexed federated repo)', () => {
    const b = assembleBoundary({
      basis: { directEdges: 1, synthesizedEdges: 0 },
      extraCrossings: [{ kind: 'unindexed-repo', count: 1, detail: 'repo X not indexed' }],
    });
    expect(b.complete).toBe(false);
    expect(b.knownUnknowable![0].kind).toBe('unindexed-repo');
  });
});

describe('buildStalenessMarker (pure decision)', () => {
  it('stays silent when no build commit was captured', () => {
    expect(buildStalenessMarker(null, 3)).toBeUndefined();
  });

  it('stays silent when the change count is unknown (not a git repo / git failed)', () => {
    expect(buildStalenessMarker('abc1234', null)).toBeUndefined();
  });

  it('treats zero changed source files as a current index', () => {
    expect(buildStalenessMarker('abc1234', 0)).toBeUndefined();
  });

  it('emits a marker naming the commit and count when source changed', () => {
    const m = buildStalenessMarker('abc1234', 4);
    expect(m).toEqual({
      indexCommit: 'abc1234',
      filesChangedSince: 4,
      detail: expect.stringContaining('commit abc1234'),
    });
    expect(m!.detail).toContain('4 source file(s) changed');
  });
});

describe('computeStaleness (integration)', () => {
  let dir: string;
  beforeEach(() => {
    __resetStalenessMemo();
    dir = mkdtempSync(join(tmpdir(), 'cb-stale-'));
    mkdirSync(join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR), { recursive: true });
  });

  const writeFingerprint = (obj: object) =>
    writeFileSync(join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_FINGERPRINT), JSON.stringify(obj));

  it('stays silent when no fingerprint artifact exists', async () => {
    expect(await computeStaleness(dir)).toBeUndefined();
  });

  it('stays silent when the fingerprint has no build commit (older index)', async () => {
    writeFingerprint({ hash: 'abc' });
    expect(await computeStaleness(dir)).toBeUndefined();
  });

  it('stays silent in a non-git directory even with a stored commit (count unknowable)', async () => {
    writeFingerprint({ hash: 'abc', commit: 'abc1234' });
    expect(await computeStaleness(dir)).toBeUndefined();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
});

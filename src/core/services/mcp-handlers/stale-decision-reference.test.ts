import { describe, it, expect } from 'vitest';
import {
  findStaleDecisionReferences,
  buildRetirementGraph,
  type StaleReferenceInputs,
} from './stale-decision-reference.js';
import type { PendingDecision, AnchoredMemory, MemoryFreshness } from '../../../types/index.js';

function decision(p: Partial<PendingDecision> & { id: string }): PendingDecision {
  return {
    id: p.id,
    status: p.status ?? 'approved',
    title: p.title ?? `decision ${p.id}`,
    rationale: p.rationale ?? '',
    consequences: p.consequences ?? '',
    proposedRequirement: p.proposedRequirement ?? null,
    affectedDomains: p.affectedDomains ?? [],
    affectedFiles: p.affectedFiles ?? [],
    anchors: p.anchors,
    supersedes: p.supersedes,
    sessionId: p.sessionId ?? 's1',
    recordedAt: p.recordedAt ?? '2026-06-23T00:00:00Z',
    confidence: p.confidence ?? 'high',
    syncedToSpecs: p.syncedToSpecs ?? [],
  };
}

function memory(p: Partial<AnchoredMemory> & { id: string; content: string }): AnchoredMemory {
  return {
    id: p.id,
    kind: 'note',
    content: p.content,
    anchors: p.anchors ?? [{ filePath: 'src/x.ts', symbolName: 'x', nodeId: 'src/x.ts::x' }],
    recordedAt: p.recordedAt ?? '2026-06-23T00:00:00Z',
    invalidatedAt: p.invalidatedAt,
  };
}

const allFresh = (): MemoryFreshness => 'fresh';

function run(partial: Partial<StaleReferenceInputs>) {
  return findStaleDecisionReferences({
    decisions: partial.decisions ?? [],
    memories: partial.memories ?? [],
    specs: partial.specs ?? [],
    freshnessOf: partial.freshnessOf ?? allFresh,
  });
}

// B superseded by C (the canonical retirement) used across scenarios.
const B = decision({ id: 'bbbbbbbb', title: 'use bcrypt' });
const C = decision({ id: 'cccccccc', title: 'use argon2', supersedes: 'bbbbbbbb', rationale: 'replaces bbbbbbbb' });

describe('buildRetirementGraph', () => {
  it('maps a retired decision to its active superseder', () => {
    const g = buildRetirementGraph([B, C]);
    expect(g.supersededBy.get('bbbbbbbb')).toBe('cccccccc');
  });
  it('a rejected superseder does not retire its target', () => {
    const rejectedC = decision({ id: 'cccccccc', supersedes: 'bbbbbbbb', status: 'rejected' });
    expect(buildRetirementGraph([B, rejectedC]).supersededBy.size).toBe(0);
  });
});

describe('findStaleDecisionReferences', () => {
  // Scenario: a live decision still cites a superseded decision.
  it('flags an approved decision whose rationale cites the retired decision', () => {
    const A = decision({ id: 'aaaaaaaa', title: 'auth flow', rationale: 'builds on bbbbbbbb for hashing' });
    const out = run({ decisions: [A, B, C] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 'stale-decision-reference',
      severity: 'warn',
      referencingArtifact: { kind: 'decision', id: 'aaaaaaaa' },
      retiredDecision: 'bbbbbbbb',
      supersededBy: 'cccccccc',
    });
  });

  // Scenario: the superseding decision is not flagged for its own supersedes edge.
  it('exempts the superseding decision — C citing B via supersedes produces no finding', () => {
    // C.rationale also mentions bbbbbbbb, but C is the superseder (exempt edge).
    const out = run({ decisions: [B, C] });
    expect(out).toHaveLength(0);
  });

  // Scenario: a reference to a live decision is clean.
  it('does not flag a memory that references a live (non-retired) decision', () => {
    const mem = memory({ id: 'm1111111', content: 'follow cccccccc when hashing' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(0);
  });

  it('flags a non-orphaned memory that cites the retired decision', () => {
    const mem = memory({ id: 'm2222222', content: 'hashing per bbbbbbbb' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact).toMatchObject({ kind: 'memory', id: 'm2222222' });
  });

  // Scenario: an orphaned memory is not treated as authoritative.
  it('does NOT flag an orphaned memory even if it cites the retired decision', () => {
    const mem = memory({ id: 'm3333333', content: 'hashing per bbbbbbbb' });
    const out = run({ decisions: [B, C], memories: [mem], freshnessOf: () => 'orphaned' });
    expect(out).toHaveLength(0);
  });

  it('does NOT flag an invalidated memory (history, not authoritative)', () => {
    const mem = memory({ id: 'm4444444', content: 'hashing per bbbbbbbb', invalidatedAt: '2026-06-22T00:00:00Z' });
    const out = run({ decisions: [B, C], memories: [mem] });
    expect(out).toHaveLength(0);
  });

  it('flags a spec requirement that still names the retired decision', () => {
    const spec = {
      file: 'openspec/specs/auth/spec.md',
      text: '# Auth\n\n### Requirement: Hashing\n\n> Decision recorded: bbbbbbbb\n',
    };
    const out = run({ decisions: [B, C], specs: [spec] });
    expect(out).toHaveLength(1);
    expect(out[0].referencingArtifact.kind).toBe('spec');
    expect(out[0].referencingArtifact.label).toContain('Requirement: Hashing');
  });

  it('a draft decision is not authoritative — not flagged', () => {
    const draft = decision({ id: 'dddddddd', status: 'draft', rationale: 'uses bbbbbbbb' });
    expect(run({ decisions: [draft, B, C] })).toHaveLength(0);
  });

  it('emits nothing when no decision is superseded', () => {
    const A = decision({ id: 'aaaaaaaa', rationale: 'uses bbbbbbbb' });
    const liveB = decision({ id: 'bbbbbbbb' }); // not superseded by anyone
    expect(run({ decisions: [A, liveB] })).toHaveLength(0);
  });

  it('output is deterministic and order-independent', () => {
    const A = decision({ id: 'aaaaaaaa', rationale: 'uses bbbbbbbb' });
    const mem = memory({ id: 'm2222222', content: 'per bbbbbbbb' });
    const a = run({ decisions: [A, B, C], memories: [mem] });
    const b = run({ decisions: [C, B, A], memories: [mem] });
    expect(a).toEqual(b);
  });
});

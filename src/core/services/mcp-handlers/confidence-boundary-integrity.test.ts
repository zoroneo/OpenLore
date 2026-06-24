/**
 * The index-integrity verdict flows into the confidence-boundary disclosure so every
 * conclusion answer over a non-reconciled index is labeled incomplete
 * (change: add-index-integrity-attestation).
 */
import { describe, it, expect } from 'vitest';
import { assembleBoundary, integrityDisclosure } from './confidence-boundary.js';
import type { IndexIntegrity } from '../../analyzer/index-attestation.js';

const integrity = (verdict: IndexIntegrity['verdict']): IndexIntegrity => ({
  verdict, detail: `index is ${verdict}`,
  committed: { files: 1, functions: 1, edges: 0, classes: 0 },
  persisted: { schemaVersion: 8, files: 1, functions: 1, edges: 0, classes: 0 },
});

describe('integrityDisclosure', () => {
  it('discloses degraded and mismatched verdicts', () => {
    expect(integrityDisclosure(integrity('degraded'))).toEqual({ verdict: 'degraded', detail: 'index is degraded' });
    expect(integrityDisclosure(integrity('mismatched'))).toEqual({ verdict: 'mismatched', detail: 'index is mismatched' });
  });
  it('discloses nothing for healthy or unverifiable (undefined) indexes', () => {
    expect(integrityDisclosure(integrity('healthy'))).toBeUndefined();
    expect(integrityDisclosure(undefined)).toBeUndefined();
  });
});

describe('assembleBoundary integrity wiring', () => {
  it('attaches the disclosure and marks the answer incomplete on a degraded index', () => {
    const b = assembleBoundary({ integrity: integrity('degraded') });
    expect(b.integrity).toEqual({ verdict: 'degraded', detail: 'index is degraded' });
    expect(b.complete).toBe(false);
  });

  it('a healthy index leaves completeness to the other signals (no integrity field)', () => {
    const b = assembleBoundary({ basis: { directEdges: 3, synthesizedEdges: 0 }, integrity: integrity('healthy') });
    expect(b.integrity).toBeUndefined();
    expect(b.complete).toBe(true);
  });

  it('a mismatched index is incomplete even when the basis is all direct edges', () => {
    const b = assembleBoundary({ basis: { directEdges: 5, synthesizedEdges: 0 }, integrity: integrity('mismatched') });
    expect(b.complete).toBe(false);
    expect(b.integrity?.verdict).toBe('mismatched');
  });
});

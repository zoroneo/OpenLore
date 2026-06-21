/**
 * Behavioral hotspots — computeBehavioralHotspots() over synthetic lease telemetry.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  computeBehavioralHotspots,
  readHotspotArtifact,
  hotspotsForModules,
  HOTSPOT,
  HOTSPOT_ARTIFACT_FILE,
} from './behavioral-hotspots.js';
import type { LeaseHotspotEvent, BehavioralHotspotReport } from './behavioral-hotspots.js';

const ev = (over: Partial<LeaseHotspotEvent>): LeaseHotspotEvent =>
  ({ ts: '2026-06-21T10:00:00Z', event: 'degraded', ...over });

describe('computeBehavioralHotspots', () => {
  it('empty input → no hotspots', () => {
    const r = computeBehavioralHotspots([]);
    expect(r.hotspots).toEqual([]);
    expect(r.modules_observed).toBe(0);
    expect(r.generated_from_events).toBe(0);
  });

  it('ignores orient_reset and null-module events', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'orient_reset', module: null }),
      ev({ event: 'degraded', module: undefined }),
      ev({ event: 'repo_moved', module: 'auth' }), // not a destabilization event
    ]);
    expect(r.generated_from_events).toBe(0);
    expect(r.hotspots).toEqual([]);
  });

  it('groups destabilization events by module and counts them', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'degraded', module: 'auth', tool: 'search_code' }),
      ev({ event: 'stale', module: 'auth', tool: 'get_subgraph', depth: 2 }),
      ev({ event: 'degraded', module: 'billing', tool: 'search_code' }),
    ]);
    expect(r.modules_observed).toBe(2);
    const auth = r.hotspots.find((h) => h.module === 'auth')!;
    expect(auth.events).toBe(2);
    expect(auth.tools).toEqual(['get_subgraph', 'search_code']);
  });

  it('labels deep-stale / high-oscillation / cross-module-drift from thresholds', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'depth_escalate', module: 'auth', to_depth: HOTSPOT.DEEP_STALE_DEPTH, density: 0.9, oscillation: 0.8 }),
    ]);
    const auth = r.hotspots[0];
    expect(auth.labels).toContain('deep-stale');
    expect(auth.labels).toContain('high-oscillation');
    expect(auth.labels).toContain('cross-module-drift');
  });

  it('omits labels below threshold', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'degraded', module: 'calm', depth: 1, density: 0.2, oscillation: 0.1 }),
    ]);
    expect(r.hotspots[0].labels).toEqual([]);
  });

  it('ranks by event count, then max depth', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'degraded', module: 'low' }),
      ev({ event: 'degraded', module: 'high' }),
      ev({ event: 'stale', module: 'high', depth: 3 }),
      ev({ event: 'degraded', module: 'high' }),
    ]);
    expect(r.hotspots[0].module).toBe('high');
    expect(r.hotspots[0].events).toBe(3);
    expect(r.hotspots[1].module).toBe('low');
  });

  it('averages density and oscillation across a module\'s events', () => {
    const r = computeBehavioralHotspots([
      ev({ event: 'degraded', module: 'auth', density: 0.4, oscillation: 0.2 }),
      ev({ event: 'stale', module: 'auth', density: 0.6, oscillation: 0.8, depth: 2 }),
    ]);
    expect(r.hotspots[0].avg_density).toBe(0.5);
    expect(r.hotspots[0].avg_oscillation).toBe(0.5);
  });

  it('respects the topN cap', () => {
    const events: LeaseHotspotEvent[] = [];
    for (const m of ['a', 'b', 'c', 'd']) events.push(ev({ event: 'degraded', module: m }));
    const r = computeBehavioralHotspots(events, 2);
    expect(r.hotspots).toHaveLength(2);
    expect(r.modules_observed).toBe(4); // total still reported
  });
});

describe('readHotspotArtifact', () => {
  it('returns null when the artifact is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-art-'));
    try {
      expect(readHotspotArtifact(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null on corrupt JSON (fail-open)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-art-'));
    try {
      writeFileSync(join(dir, HOTSPOT_ARTIFACT_FILE), 'not json {{{');
      expect(readHotspotArtifact(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns null when hotspots is not an array (wrong shape)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-art-'));
    try {
      writeFileSync(join(dir, HOTSPOT_ARTIFACT_FILE), JSON.stringify({ hotspots: 'nope' }));
      expect(readHotspotArtifact(dir)).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('drops malformed hotspot entries (regression: orient must not surface garbage)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-art-'));
    try {
      writeFileSync(join(dir, HOTSPOT_ARTIFACT_FILE), JSON.stringify({
        hotspots: [
          { module: 'auth', events: 5, max_depth: 3, labels: ['deep-stale'] },        // valid
          { module: 'billing', events: 2, max_depth: 1, labels: 'not-an-array' },      // labels not array
          { module: 12345, events: 1, max_depth: 1, labels: [] },                      // module not string
          { module: 'payments', events: 'lots', max_depth: 1, labels: [] },            // events not number
          { module: 'orders', max_depth: 1, labels: [1, 2] },                          // labels not strings
          'totally wrong',                                                             // not an object
        ],
      }));
      const read = readHotspotArtifact(dir);
      expect(read?.hotspots.map((h) => h.module)).toEqual(['auth']); // only the valid one survives
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reads a well-formed artifact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-art-'));
    try {
      const report = computeBehavioralHotspots([
        { ts: '2026-06-21T10:00:00Z', event: 'depth_escalate', module: 'auth', to_depth: 3, density: 0.9, oscillation: 0.8 },
      ]);
      writeFileSync(join(dir, HOTSPOT_ARTIFACT_FILE), JSON.stringify(report));
      const read = readHotspotArtifact(dir);
      expect(read?.hotspots[0].module).toBe('auth');
      expect(read?.hotspots[0].labels).toContain('deep-stale');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('hotspotsForModules', () => {
  const report: BehavioralHotspotReport = {
    generated_from_events: 3, modules_observed: 3,
    hotspots: [
      { module: 'auth', events: 5, max_depth: 3, avg_density: 0.8, avg_oscillation: 0.7, tools: [], labels: ['deep-stale'] },
      { module: 'billing', events: 1, max_depth: 1, avg_density: 0.2, avg_oscillation: 0.1, tools: [], labels: [] },
      { module: 'payments', events: 2, max_depth: 2, avg_density: 0.3, avg_oscillation: 0.2, tools: [], labels: [] },
    ],
  };
  it('filters to hotspots whose module is in the set', () => {
    const hits = hotspotsForModules(report, new Set(['auth', 'payments']));
    expect(hits.map((h) => h.module)).toEqual(['auth', 'payments']);
  });
  it('returns empty when no module matches', () => {
    expect(hotspotsForModules(report, new Set(['unknown']))).toEqual([]);
  });
});

/**
 * Behavioral hotspots — the observe → memory feedback loop.
 *
 * Turns behavioral *observations* (epistemic-lease telemetry) into a durable, deterministic signal
 * about WHERE in the codebase agents destabilize. This is the north-star direction of the panic
 * work: not a momentary nudge after an agent is already lost, but a memory/orient signal that helps
 * the NEXT agent arrive better-oriented to the regions that reliably cause trouble.
 *
 * Deterministic and read-only. No LLM, no composite "score" tuning knob — each hotspot carries raw
 * counts and labeled signals (deep-stale / high-oscillation / cross-module-drift); ranking is by
 * episode count. The memory/orient layer decides what to do with it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** An epistemic-lease.jsonl record (subset this analysis reads). */
export interface LeaseHotspotEvent {
  ts: string;
  event: string; // 'degraded' | 'stale' | 'depth_escalate' | 'orient_reset' | 'repo_moved'
  module?: string | null;
  tool?: string;
  depth?: number;
  to_depth?: number;
  density?: number;
  oscillation?: number;
}

export type HotspotLabel = 'deep-stale' | 'high-oscillation' | 'cross-module-drift';

export interface BehavioralHotspot {
  module: string;
  /** destabilization events (degraded / stale / depth_escalate) attributed to this module. */
  events: number;
  max_depth: number;
  avg_density: number;
  avg_oscillation: number;
  tools: string[];
  /** labeled signals (not a blended score) — what kind of trouble this region produces. */
  labels: HotspotLabel[];
}

export interface BehavioralHotspotReport {
  generated_from_events: number;
  modules_observed: number;
  hotspots: BehavioralHotspot[];
}

/** Filename of the persisted artifact, relative to the analysis dir. */
export const HOTSPOT_ARTIFACT_FILE = 'behavioral-hotspots.json';

/**
 * Read the persisted hotspot artifact (written by `openlore panic-hotspots --write`) from an
 * analysis directory. Fail-open: returns null on any error (missing/corrupt/wrong-shape).
 */
export function readHotspotArtifact(analysisDir: string): BehavioralHotspotReport | null {
  try {
    const path = join(analysisDir, HOTSPOT_ARTIFACT_FILE);
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<BehavioralHotspotReport>;
    if (!Array.isArray(parsed.hotspots)) return null;
    // Validate each hotspot's shape and drop malformed entries — a hand-edited or
    // version-shifted artifact must never inject garbage into a consumer (e.g. orient's result).
    const hotspots = parsed.hotspots.filter(isWellFormedHotspot);
    return {
      generated_from_events: typeof parsed.generated_from_events === 'number' ? parsed.generated_from_events : 0,
      modules_observed: typeof parsed.modules_observed === 'number' ? parsed.modules_observed : 0,
      hotspots,
    };
  } catch {
    return null;
  }
}

/** A hotspot is usable only if its core fields have the expected types. */
function isWellFormedHotspot(h: unknown): h is BehavioralHotspot {
  if (typeof h !== 'object' || h === null) return false;
  const o = h as Record<string, unknown>;
  return (
    typeof o.module === 'string' &&
    typeof o.events === 'number' &&
    typeof o.max_depth === 'number' &&
    Array.isArray(o.labels) &&
    o.labels.every((l) => typeof l === 'string')
  );
}

/** Hotspots whose module is in `modules` (contextual filtering for orient). */
export function hotspotsForModules(report: BehavioralHotspotReport, modules: Set<string>): BehavioralHotspot[] {
  return report.hotspots.filter((h) => modules.has(h.module));
}

/** Thresholds for the labeled signals — referenced by tests. */
export const HOTSPOT = {
  DEEP_STALE_DEPTH: 3,
  HIGH_OSCILLATION: 0.5,
  CROSS_MODULE_DRIFT_DENSITY: 0.6,
} as const;

const DESTABILIZATION_EVENTS = new Set(['degraded', 'stale', 'depth_escalate']);

/**
 * Aggregate per-module destabilization from epistemic-lease telemetry.
 * @param topN cap the returned hotspots (0 = all). Ranked by event count, then max depth.
 */
export function computeBehavioralHotspots(events: LeaseHotspotEvent[], topN = 0): BehavioralHotspotReport {
  const destab = events.filter((e) => DESTABILIZATION_EVENTS.has(e.event) && e.module);

  const byModule = new Map<
    string,
    { events: number; maxDepth: number; densitySum: number; densityN: number; oscSum: number; oscN: number; tools: Set<string> }
  >();

  for (const e of destab) {
    const mod = e.module as string;
    let agg = byModule.get(mod);
    if (!agg) {
      agg = { events: 0, maxDepth: 0, densitySum: 0, densityN: 0, oscSum: 0, oscN: 0, tools: new Set() };
      byModule.set(mod, agg);
    }
    agg.events++;
    agg.maxDepth = Math.max(agg.maxDepth, e.to_depth ?? e.depth ?? 0);
    if (typeof e.density === 'number') { agg.densitySum += e.density; agg.densityN++; }
    if (typeof e.oscillation === 'number') { agg.oscSum += e.oscillation; agg.oscN++; }
    if (e.tool) agg.tools.add(e.tool);
  }

  const hotspots: BehavioralHotspot[] = [...byModule.entries()]
    .map(([module, a]) => {
      const avgDensity = a.densityN ? a.densitySum / a.densityN : 0;
      const avgOscillation = a.oscN ? a.oscSum / a.oscN : 0;
      const labels: HotspotLabel[] = [];
      if (a.maxDepth >= HOTSPOT.DEEP_STALE_DEPTH) labels.push('deep-stale');
      if (avgOscillation >= HOTSPOT.HIGH_OSCILLATION) labels.push('high-oscillation');
      if (avgDensity >= HOTSPOT.CROSS_MODULE_DRIFT_DENSITY) labels.push('cross-module-drift');
      return {
        module,
        events: a.events,
        max_depth: a.maxDepth,
        avg_density: Math.round(avgDensity * 1000) / 1000,
        avg_oscillation: Math.round(avgOscillation * 1000) / 1000,
        tools: [...a.tools].sort(),
        labels,
      };
    })
    .sort((x, y) => y.events - x.events || y.max_depth - x.max_depth || x.module.localeCompare(y.module));

  return {
    generated_from_events: destab.length,
    modules_observed: byModule.size,
    hotspots: topN > 0 ? hotspots.slice(0, topN) : hotspots,
  };
}

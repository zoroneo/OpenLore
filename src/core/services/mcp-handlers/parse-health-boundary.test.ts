/**
 * Parse-health boundary surfacing (change: add-parse-health-boundary-disclosure).
 * Covers the read side: loading the artifact and building a per-conclusion boundary from the files a
 * result touches. A clean repo (no artifact) must fail open to "no boundary".
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadParseHealthReport, parseHealthBoundary } from './parse-health-boundary.js';
import { OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR, ARTIFACT_PARSE_HEALTH } from '../../../constants.js';
import type { ParseHealthReport } from '../../analyzer/parse-health.js';

function repoWith(report: ParseHealthReport | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'ph-'));
  if (report) {
    const analysisDir = join(dir, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
    mkdirSync(analysisDir, { recursive: true });
    writeFileSync(join(analysisDir, ARTIFACT_PARSE_HEALTH), JSON.stringify(report));
  }
  return dir;
}

const REPORT: ParseHealthReport = {
  version: 1,
  totalDegradedFiles: 2,
  totalErrorRegions: 3,
  byLanguage: [{ language: 'TypeScript', degradedFiles: 2, errorRegions: 3, parseFailures: 1, encodingFallbacks: 0 }],
  topFiles: [],
  files: [
    { filePath: 'src/a.ts', language: 'TypeScript', errorCount: 2, missingCount: 0, errorLines: [4, 9] },
    { filePath: 'src/b.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [], parseFailed: true },
  ],
};

describe('loadParseHealthReport', () => {
  it('returns null when no artifact exists (clean repo)', async () => {
    expect(await loadParseHealthReport(repoWith(null))).toBeNull();
  });
  it('loads a persisted report', async () => {
    const r = await loadParseHealthReport(repoWith(REPORT));
    expect(r?.totalDegradedFiles).toBe(2);
    expect(r?.files.length).toBe(2);
  });
});

describe('parseHealthBoundary', () => {
  it('is undefined when the report is null (fail open)', () => {
    expect(parseHealthBoundary(null, ['src/a.ts'])).toBeUndefined();
  });
  it('is undefined when no touched file is degraded', () => {
    expect(parseHealthBoundary(REPORT, ['src/clean.ts'])).toBeUndefined();
  });
  it('discloses a lower-bound boundary naming the degraded touched files', () => {
    const note = parseHealthBoundary(REPORT, ['src/a.ts', 'src/b.ts', 'src/clean.ts'])!;
    expect(note).toContain('LOWER BOUND');
    expect(note).toContain('src/a.ts');
    expect(note).toContain('src/b.ts');
    expect(note).toContain('parse failed');
    expect(note).not.toContain('src/clean.ts');
  });
  it('deduplicates repeated touched files', () => {
    const note = parseHealthBoundary(REPORT, ['src/a.ts', 'src/a.ts'])!;
    expect(note).toContain('1 file');
  });
});

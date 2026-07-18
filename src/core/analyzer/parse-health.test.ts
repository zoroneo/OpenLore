/**
 * Parse-health disclosure (change: add-parse-health-boundary-disclosure).
 *
 * Two layers of coverage:
 *   1. Unit — the pure module (`tallyParseHealth`, `isLossyUtf8`, `buildParseHealthReport`)
 *      over hand-built node objects, so the tally logic is tested without a grammar.
 *   2. Build — the real `CallGraphBuilder` over source with a deliberate syntax error, proving the
 *      signal fires end-to-end AND that a clean file produces no record (clean repos pay zero).
 */
import { describe, it, expect } from 'vitest';
import {
  tallyParseHealth,
  isLossyUtf8,
  buildParseHealthReport,
  isDegraded,
  compactParseHealthSummary,
  type ParseHealthNode,
  type FileParseHealth,
} from './parse-health.js';
import { CallGraphBuilder } from './call-graph.js';

/** Build a minimal node object (defaults: clean, no error). */
function node(partial: Partial<ParseHealthNode> & { type: string }): ParseHealthNode {
  return { startPosition: { row: 0 }, children: [], ...partial };
}

describe('tallyParseHealth (unit)', () => {
  it('returns undefined for a clean tree (fast path, zero cost)', () => {
    const root = node({ type: 'program', hasError: false, children: [node({ type: 'function' })] });
    expect(tallyParseHealth('TypeScript', root, 'a.ts')).toBeUndefined();
  });

  it('counts ERROR nodes and records their 1-based start lines', () => {
    const root = node({
      type: 'program',
      hasError: true,
      children: [
        node({ type: 'function', startPosition: { row: 0 } }),
        node({ type: 'ERROR', startPosition: { row: 4 } }),
      ],
    });
    const h = tallyParseHealth('TypeScript', root, 'a.ts')!;
    expect(h.errorCount).toBe(1);
    expect(h.missingCount).toBe(0);
    expect(h.errorLines).toEqual([5]); // row 4 → line 5
    expect(h.filePath).toBe('a.ts');
  });

  it('counts MISSING nodes (isMissing as property OR method)', () => {
    const root = node({
      type: 'program',
      hasError: true,
      children: [
        node({ type: 'identifier', isMissing: true, startPosition: { row: 1 } }),
        node({ type: ';', isMissing: () => true, startPosition: { row: 2 } }),
      ],
    });
    const h = tallyParseHealth('Python', root, 'b.py')!;
    expect(h.missingCount).toBe(2);
    expect(h.errorLines).toEqual([2, 3]);
  });

  it('bounds the error-line list and discloses truncation', () => {
    const children = Array.from({ length: 40 }, (_, i) => node({ type: 'ERROR', startPosition: { row: i } }));
    const root = node({ type: 'program', hasError: true, children });
    const h = tallyParseHealth('Go', root, 'c.go')!;
    expect(h.errorCount).toBe(40);
    expect(h.errorLines.length).toBe(25); // PARSE_HEALTH_LINE_CAP
    expect(h.truncated).toBe(true);
  });

  it('drops a spurious hasError=true with no confirmed ERROR/MISSING node (sound lower bound)', () => {
    // Some grammars flag hasError on well-formed input; over-reporting would cry wolf, so a signal
    // with no actual error node is dropped, not fabricated.
    const root = node({ type: 'program', hasError: true, startPosition: { row: 7 }, children: [] });
    expect(tallyParseHealth('Ruby', root, 'd.rb')).toBeUndefined();
  });
});

describe('isLossyUtf8', () => {
  it('is false for valid UTF-8, including a legitimately-present U+FFFD (EF BF BD)', () => {
    expect(isLossyUtf8(new TextEncoder().encode('const x = 1;'))).toBe(false);
    // A source that legitimately CONTAINS U+FFFD encodes to valid UTF-8 — not a lossy decode.
    expect(isLossyUtf8(new TextEncoder().encode('const x = "�";'))).toBe(false);
  });
  it('is true for genuinely invalid UTF-8 byte sequences', () => {
    expect(isLossyUtf8(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toBe(true); // lone 0xFF/0xFE
    expect(isLossyUtf8(new Uint8Array([0xc0, 0x80]))).toBe(true); // overlong encoding
  });
});

describe('buildParseHealthReport', () => {
  it('returns undefined when nothing is degraded', () => {
    expect(buildParseHealthReport([])).toBeUndefined();
    const clean: FileParseHealth = { filePath: 'a.ts', language: 'TypeScript', errorCount: 0, missingCount: 0, errorLines: [] };
    expect(isDegraded(clean)).toBe(false);
    expect(buildParseHealthReport([clean])).toBeUndefined();
  });

  it('rolls up per-language counts, sorts top files, and keeps every record', () => {
    const records: FileParseHealth[] = [
      { filePath: 'a.ts', language: 'TypeScript', errorCount: 3, missingCount: 0, errorLines: [1] },
      { filePath: 'b.ts', language: 'TypeScript', errorCount: 1, missingCount: 0, errorLines: [2] },
      { filePath: 'c.py', language: 'Python', errorCount: 0, missingCount: 0, errorLines: [], parseFailed: true },
      { filePath: 'd.go', language: 'Go', errorCount: 0, missingCount: 0, errorLines: [], encodingFallback: true },
    ];
    const report = buildParseHealthReport(records)!;
    expect(report.totalDegradedFiles).toBe(4);
    expect(report.totalErrorRegions).toBe(4);
    const ts = report.byLanguage.find(l => l.language === 'TypeScript')!;
    expect(ts.degradedFiles).toBe(2);
    expect(ts.errorRegions).toBe(4);
    expect(report.byLanguage.find(l => l.language === 'Python')!.parseFailures).toBe(1);
    expect(report.byLanguage.find(l => l.language === 'Go')!.encodingFallbacks).toBe(1);
    // Worst offender (a.ts, 3 regions) ranks first.
    expect(report.topFiles[0].filePath).toBe('a.ts');
    expect(report.files.length).toBe(4);
    expect(compactParseHealthSummary(report).length).toBe(3); // one line per language
  });
});

describe('CallGraphBuilder parse-health capture (build integration)', () => {
  it('records a parse-health entry for a file with a syntax error, and still extracts prior symbols', async () => {
    // `good` is a well-formed function; the trailing `function broken(` is unterminated → ERROR.
    const content = `function good() { return 1; }\nfunction broken( {\n`;
    const r = await new CallGraphBuilder().build([{ path: 'x.ts', content, language: 'TypeScript' }]);
    const names = [...r.nodes.values()].map(n => n.name);
    expect(names, 'the well-formed function before the error is still extracted').toContain('good');
    const health = r.parseHealthByFile?.get('x.ts');
    expect(health, 'the syntax error is recorded as a parse-health signal').toBeDefined();
    expect(isDegraded(health!)).toBe(true);
    expect(health!.errorCount + health!.missingCount).toBeGreaterThan(0);
  });

  it('produces NO parse-health record for a clean file (clean repos pay zero)', async () => {
    const content = `function a() { return b(); }\nfunction b() { return 1; }\n`;
    const r = await new CallGraphBuilder().build([{ path: 'y.ts', content, language: 'TypeScript' }]);
    expect(r.parseHealthByFile?.get('y.ts')).toBeUndefined();
  });
});

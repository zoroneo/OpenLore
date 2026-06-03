/**
 * Spec 25 Phase D — agent-eval core (the basis for `openlore prove`).
 * Deterministic parts only; no real agent is ever invoked.
 */
import { describe, it, expect } from 'vitest';
import { parseAgentJson, summarize, median, type Metrics } from './measure.js';
import { deriveTasks, scoreAnswer, type GraphFact } from './tasks.js';
import { computeScorecard, verdict, renderScorecard } from './scorecard.js';

describe('parseAgentJson', () => {
  it('extracts fresh/cached/cost/turns from a claude -p json blob', () => {
    const raw = JSON.stringify({
      result: 'the answer is foo',
      total_cost_usd: 0.123,
      num_turns: 9,
      duration_ms: 4200,
      usage: { input_tokens: 1000, cache_creation_input_tokens: 500, cache_read_input_tokens: 8000, output_tokens: 300 },
    });
    const m = parseAgentJson(raw);
    expect(m.freshInputTokens).toBe(1500); // input + cache_creation
    expect(m.cacheReadTokens).toBe(8000);
    expect(m.costUsd).toBe(0.123);
    expect(m.numTurns).toBe(9);
    expect(m.answer).toBe('the answer is foo');
  });

  it('tolerates a missing usage block', () => {
    const m = parseAgentJson(JSON.stringify({ result: 'x' }));
    expect(m.freshInputTokens).toBe(0);
    expect(m.costUsd).toBe(0);
  });
});

describe('median + summarize', () => {
  it('median handles even and odd counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBe(0);
  });
  it('summarize medians the cells and computes correctRate', () => {
    const runs: Metrics[] = [
      { freshInputTokens: 100, cacheReadTokens: 0, outputTokens: 10, costUsd: 0.1, numTurns: 4, durationMs: 1000, answer: 'a', correct: true },
      { freshInputTokens: 200, cacheReadTokens: 0, outputTokens: 10, costUsd: 0.3, numTurns: 6, durationMs: 2000, answer: 'b', correct: false },
    ];
    const cell = summarize(runs);
    expect(cell.costUsd).toBeCloseTo(0.2);
    expect(cell.numTurns).toBe(5);
    expect(cell.correctRate).toBe(0.5);
    expect(cell.runs).toBe(2);
  });
});

describe('deriveTasks', () => {
  const facts: GraphFact[] = [
    { name: 'validateDirectory', filePath: 'src/utils.ts', callerNames: ['c1', 'c2', 'c3'], calleeNames: [], isEntryPoint: false },
    { name: 'leaf', filePath: 'b.ts', callerNames: ['c1'], calleeNames: [], isEntryPoint: false },
    { name: 'startMcpServer', filePath: 'src/mcp.ts', callerNames: [], calleeNames: ['validateDirectory', 'leaf'], isEntryPoint: true },
  ];

  it('derives a locate task oracled by the file path/stem (robust, unambiguous)', () => {
    const locate = deriveTasks(facts).find(t => t.id === 'locate')!;
    expect(locate.prompt).toContain('validateDirectory');
    expect(locate.mustIncludeAny).toContain('src/utils.ts');
    expect(locate.mustIncludeAny).toContain('utils'); // file stem
  });

  it('does NOT emit an ambiguous "most callers" task', () => {
    expect(deriveTasks(facts).find(t => t.id === 'hub')).toBeUndefined();
  });

  it('derives a caller task oracled by any real caller', () => {
    const caller = deriveTasks(facts).find(t => t.id === 'caller')!;
    expect(caller.mustIncludeAny).toEqual(['c1', 'c2', 'c3']);
  });

  it('derives a callee task from a distinctive high-fan-out function', () => {
    const callee = deriveTasks(facts).find(t => t.id === 'callee')!;
    expect(callee.prompt).toContain('startMcpServer');
    expect(callee.mustIncludeAny).toEqual(['validateDirectory', 'leaf']);
  });

  it('prefers a distinctively-named hub over a generic one for an unambiguous oracle', () => {
    const f: GraphFact[] = [
      { name: 'run', filePath: 'a.ts', callerNames: ['x', 'y', 'z', 'w'], calleeNames: [], isEntryPoint: false },
      { name: 'readOpenLoreConfig', filePath: 'src/config.ts', callerNames: ['x', 'y'], calleeNames: [], isEntryPoint: false },
    ];
    const locate = deriveTasks(f).find(t => t.id === 'locate')!;
    expect(locate.prompt).toContain('readOpenLoreConfig'); // distinctive, not the generic `run`
  });

  it('is deterministic (same facts → same tasks)', () => {
    expect(deriveTasks(facts)).toEqual(deriveTasks(facts));
  });

  it('returns [] for a graph too sparse to oracle', () => {
    expect(deriveTasks([{ name: 'x', filePath: 'x.ts', callerNames: [], calleeNames: [], isEntryPoint: false }])).toEqual([]);
  });
});

describe('scoreAnswer', () => {
  const task = { id: 'caller', prompt: '', mustIncludeAny: ['fooBar', 'bazQux'], probes: '' };
  it('is correct when the answer contains any oracle substring (case-insensitive)', () => {
    expect(scoreAnswer(task, 'I think FOOBAR calls it')).toBe(true);
    expect(scoreAnswer(task, 'probably bazqux')).toBe(true);
  });
  it('is incorrect when no oracle substring is present', () => {
    expect(scoreAnswer(task, 'no idea, maybe widget')).toBe(false);
  });
});

describe('scorecard verdict + render', () => {
  const cell = (cost: number, turns: number, correct: number) => ({
    costUsd: cost, freshInputTokens: 1000, cacheReadTokens: 0, numTurns: turns, durationMs: 1000, correctRate: correct, runs: 4,
  });

  it('"helps" when cost AND round-trips drop ≥5% at equal correctness', () => {
    const sc = computeScorecard(cell(0.20, 20, 1), cell(0.16, 14, 1));
    expect(sc.costDeltaPct).toBe(-20);
    expect(sc.turnsDeltaPct).toBe(-30);
    expect(sc.verdict).toBe('helps');
  });

  it('"doesn\'t help here" when WITH regresses on cost', () => {
    const sc = computeScorecard(cell(0.10, 10, 1), cell(0.15, 10, 1));
    expect(sc.verdict).toBe("doesn't help here");
  });

  it('never claims a win when correctness drops', () => {
    const sc = computeScorecard(cell(0.20, 20, 1), cell(0.10, 8, 0.5));
    expect(sc.verdict).toBe("doesn't help here");
  });

  it('"break-even" inside the ±5% band', () => {
    const sc = computeScorecard(cell(0.100, 10, 1), cell(0.102, 10, 1));
    expect(sc.verdict).toBe('break-even');
  });

  it('render marks a dry run as synthetic', () => {
    const sc = computeScorecard(cell(0.2, 20, 1), cell(0.16, 14, 1));
    expect(renderScorecard(sc, { tasks: 3, mock: true })).toContain('DRY RUN');
    expect(renderScorecard(sc, { tasks: 3, mock: false })).not.toContain('DRY RUN');
  });
});

describe('verdict (unit)', () => {
  const base = { costWithout: 0, costWith: 0, turnsWithout: 0, turnsWith: 0, correctWithout: 1, correctWith: 1, freshWithout: 0, freshWith: 0, runsPerArm: 4 };
  it('helps only when both metrics improve', () => {
    expect(verdict({ ...base, costDeltaPct: -10, turnsDeltaPct: -10 })).toBe('helps');
    expect(verdict({ ...base, costDeltaPct: -10, turnsDeltaPct: 0 })).toBe('break-even');
  });
});

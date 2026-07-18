import { describe, it, expect } from 'vitest';
import { getSkeletonContent, isSkeletonWorthIncluding } from './code-shaper.js';

// ── getSkeletonContent ────────────────────────────────────────────────────────

describe('getSkeletonContent', () => {
  it('strips console.log lines', () => {
    const src = `function run() {\n  console.log('start');\n  return 1;\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).not.toContain('console.log');
    expect(sk).toContain('return 1');
  });

  it('strips logger.* lines', () => {
    const src = `function x() {\n  logger.info('hi');\n  doWork();\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).not.toContain('logger.info');
    expect(sk).toContain('doWork()');
  });

  it('strips Python print() and logging.*', () => {
    const src = `def run():\n    print("hello")\n    logging.info("msg")\n    return 42\n`;
    const sk = getSkeletonContent(src, 'Python');
    expect(sk).not.toContain('print(');
    expect(sk).not.toContain('logging.info');
    expect(sk).toContain('return 42');
  });

  it('strips single-line // comments', () => {
    const src = `function x() {\n  // this is a comment\n  doWork();\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).not.toContain('// this is a comment');
    expect(sk).toContain('doWork()');
  });

  it('strips single-line # comments (Python)', () => {
    const src = `def x():\n    # comment\n    do_work()\n`;
    const sk = getSkeletonContent(src, 'Python');
    expect(sk).not.toContain('# comment');
    expect(sk).toContain('do_work()');
  });

  it('strips /* block comments */ but keeps code', () => {
    const src = `function x() {\n  /* skip this */\n  doWork();\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).not.toContain('skip this');
    expect(sk).toContain('doWork()');
  });

  it('keeps JSDoc /** comments */', () => {
    const src = `/**\n * Main entry point.\n */\nfunction run() {\n  return 1;\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).toContain('Main entry point');
    expect(sk).toContain('return 1');
  });

  it('keeps control flow keywords', () => {
    const src = `function x() {\n  if (a) {\n    return b;\n  } else {\n    return c;\n  }\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).toContain('if (a)');
    expect(sk).toContain('return b');
    expect(sk).toContain('return c');
  });

  it('collapses multiple consecutive blank lines to one', () => {
    const src = `function x() {\n\n\n\n  return 1;\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).not.toMatch(/\n{3,}/);
    expect(sk).toContain('return 1');
  });

  it('keeps function signatures', () => {
    const src = `async function processOrders(orders: Order[]): Promise<void> {\n  console.log('start');\n  await save(orders);\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).toContain('async function processOrders');
    expect(sk).toContain('await save(orders)');
    expect(sk).not.toContain('console.log');
  });

  it('returns content unchanged when there is nothing to strip', () => {
    const src = `function x() {\n  return 1;\n}`;
    const sk = getSkeletonContent(src, 'TypeScript');
    expect(sk).toBe(src);
  });
});

// `detectLanguage` moved to the single canonical source in `language-support.ts`
// (change: fix-language-detection-single-source); its coverage + singularity guard now
// live in `language-support.test.ts`.

// ── isSkeletonWorthIncluding ──────────────────────────────────────────────────

describe('isSkeletonWorthIncluding', () => {
  it('returns true when skeleton is < 80% of original', () => {
    const original = 'x'.repeat(1000);
    const skeleton = 'x'.repeat(700);
    expect(isSkeletonWorthIncluding(original, skeleton)).toBe(true);
  });

  it('returns false when skeleton is >= 80% of original', () => {
    const original = 'x'.repeat(1000);
    const skeleton = 'x'.repeat(850);
    expect(isSkeletonWorthIncluding(original, skeleton)).toBe(false);
  });

  it('returns false for empty original', () => {
    expect(isSkeletonWorthIncluding('', '')).toBe(false);
  });
});

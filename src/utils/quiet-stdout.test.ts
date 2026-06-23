/**
 * The stdout-purity primitive behind every surfaced `--json` command
 * (orient/verify/drift/decisions). If this util regresses, those machine modes
 * leak logs onto stdout, so it is worth a focused test.
 */
import { describe, it, expect, vi } from 'vitest';
import { redirectConsoleToStderr, withQuietStdout } from './quiet-stdout.js';

describe('redirectConsoleToStderr', () => {
  it('routes console.log/info/warn to stderr and restores the originals', () => {
    const origLog = console.log;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const restore = redirectConsoleToStderr();
    expect(console.log).not.toBe(origLog); // swapped while active
    console.log('hello');
    console.info('info');
    console.warn('warn');
    restore();

    expect(console.log).toBe(origLog); // restored
    expect(stderr).toHaveBeenCalledTimes(3);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain('hello');
    stderr.mockRestore();
  });

  it('does NOT touch console.error (errors already go to stderr)', () => {
    const origError = console.error;
    const restore = redirectConsoleToStderr();
    expect(console.error).toBe(origError);
    restore();
  });

  it('withQuietStdout restores even when the body throws', async () => {
    const origLog = console.log;
    await expect(
      withQuietStdout(async () => {
        expect(console.log).not.toBe(origLog);
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(console.log).toBe(origLog);
  });
});

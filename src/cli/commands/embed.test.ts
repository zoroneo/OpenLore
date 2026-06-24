import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { embedCommand } from './embed.js';

// Covers the embed command's argument-validation branches, which run before any
// config read or index build (so no analyze pipeline is triggered).

describe('openlore embed — flag validation', () => {
  beforeEach(() => { process.exitCode = 0; });
  afterEach(() => { process.exitCode = 0; vi.restoreAllMocks(); });

  it('errors when neither --local nor --off is given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await embedCommand.parseAsync([], { from: 'user' });
    expect(process.exitCode).toBe(1);
  });

  it('errors when both --local and --off are given', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await embedCommand.parseAsync(['--local', '--off'], { from: 'user' });
    expect(process.exitCode).toBe(1);
  });

  it('exposes --local, --off, and --model options', () => {
    const names = embedCommand.options.map(o => o.long);
    expect(names).toContain('--local');
    expect(names).toContain('--off');
    expect(names).toContain('--model');
  });
});

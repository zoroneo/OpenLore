/**
 * Tests for the `telemetry --live` tail resilience (harden-runtime-event-resilience).
 *
 * `tailTelemetryFile` runs for the lifetime of a `--live` session. Two defects it
 * must not have: (1) an unhandled read-stream 'error' crashes the session and
 * wedges the file's tail forever (in-flight guard never cleared); (2) after log
 * rotation (the writer renames the file at the size threshold and restarts it
 * small) a stale byte offset points past the new small file, so the tail reads
 * zero bytes and goes silently empty until the file regrows. These tests pin the
 * stream-error handler and the structural rotation reset (current size < stored
 * offset ⇒ start over).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tailTelemetryFile, type TelemetryTailState } from './telemetry.js';

function mcpLine(tool: string, ms: number): string {
  return JSON.stringify({ ts: '2026-07-19T12:00:00.000Z', event: 'tool_call', tool, ms }) + '\n';
}

async function setup(): Promise<{ dir: string; mcpFile: string; leaseFile: string; state: TelemetryTailState }> {
  const dir = await mkdtemp(join(tmpdir(), 'tel-tail-'));
  const leaseFile = join(dir, 'epistemic-lease.jsonl');
  const mcpFile = join(dir, 'mcp.jsonl');
  const state: TelemetryTailState = { offsets: new Map(), inFlight: new Set(), leaseFile };
  return { dir, mcpFile, leaseFile, state };
}

describe('tailTelemetryFile — live tail resilience', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    logSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('renders appended lines and advances the offset', async () => {
    const { mcpFile, state } = await setup();
    const line = mcpLine('orient', 12);
    await writeFile(mcpFile, line, 'utf-8');

    await tailTelemetryFile(mcpFile, state);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('orient');
    expect(state.offsets.get(mcpFile)).toBe(Buffer.byteLength(line, 'utf-8'));
    expect(state.inFlight.has(mcpFile)).toBe(false);
  });

  it('resets a stale offset after rotation (size < stored offset) and renders the new file', async () => {
    const { mcpFile, state } = await setup();
    // A stale offset left over from before rotation, far past the new small file.
    state.offsets.set(mcpFile, 10_000);
    const line = mcpLine('recall', 5);
    await writeFile(mcpFile, line, 'utf-8');  // small, post-rotation file

    await tailTelemetryFile(mcpFile, state);

    // Without the reset the stream would start past EOF and render nothing.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('recall');
    expect(state.offsets.get(mcpFile)).toBe(Buffer.byteLength(line, 'utf-8'));
  });

  it('survives a read-stream error, clears the in-flight guard, and discloses once', async () => {
    const { dir, state } = await setup();
    // createReadStream on a directory emits EISDIR 'error' deterministically —
    // stands in for "the file was renamed away by rotation between watch and open".
    const badPath = join(dir, 'rotated-away');
    await mkdir(badPath);

    await expect(tailTelemetryFile(badPath, state)).resolves.toBeUndefined();

    expect(state.inFlight.has(badPath)).toBe(false);
    const disclosed = stderrSpy.mock.calls.map((c: unknown[]) => String(c[0])).join('');
    expect(disclosed).toMatch(/tail of .* failed/);

    // The session is still usable: a later good file on the same state renders.
    const good = join(dir, 'mcp.jsonl');
    await writeFile(good, mcpLine('search_code', 3), 'utf-8');
    await tailTelemetryFile(good, state);
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('search_code');
  });

  it('skips a file already in flight (no overlapping read)', async () => {
    const { mcpFile, state } = await setup();
    await writeFile(mcpFile, mcpLine('orient', 1), 'utf-8');
    state.inFlight.add(mcpFile);

    await tailTelemetryFile(mcpFile, state);

    expect(logSpy).not.toHaveBeenCalled();
    // The guard stays set — the in-flight owner clears it, not this skipped call.
    expect(state.inFlight.has(mcpFile)).toBe(true);
  });

  it('reads only the newly appended bytes on a second tail', async () => {
    const { mcpFile, state } = await setup();
    await writeFile(mcpFile, mcpLine('orient', 1), 'utf-8');
    await tailTelemetryFile(mcpFile, state);
    logSpy.mockClear();

    await writeFile(mcpFile, mcpLine('orient', 1) + mcpLine('recall', 2), 'utf-8');
    await tailTelemetryFile(mcpFile, state);

    // Only the second line is new; the first was already consumed.
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(String(logSpy.mock.calls[0][0])).toContain('recall');
  });
});

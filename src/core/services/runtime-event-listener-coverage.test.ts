/**
 * Coverage guard for harden-runtime-event-resilience.
 *
 * A grep-shaped, no-machinery lint: every long-lived event-emitter site — a
 * filesystem watcher in a process that outlives one request, or a read stream
 * that a live tail opens — MUST register an 'error' listener. An unhandled
 * 'error' event on an EventEmitter throws, and these production paths install no
 * uncaughtException handler, so an unlistened error is fatal (the daemon) or
 * crashes/wedges the session (the tail). This test fails, NAMING the site, if a
 * new registration ships without its 'error' listener.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function fileText(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf-8');
}

describe('runtime event-emitter error-listener coverage', () => {
  const WATCHER_FILE = 'src/core/services/mcp-watcher.ts';

  it('every named chokidar watcher in the MCP watcher registers an error listener', () => {
    const src = fileText(WATCHER_FILE);
    // Known long-lived watcher sites, by the field they assign. Each must have a
    // paired `this.<field>.on('error', …)` registration.
    const watcherFields = Array.from(src.matchAll(/this\.(\w+)\s*=\s*chokidar\.watch\(/g)).map(m => m[1]);
    expect(watcherFields.length).toBeGreaterThan(0);
    for (const field of watcherFields) {
      const hasErrorListener = new RegExp(`this\\.${field}\\.on\\('error'`).test(src);
      expect(
        hasErrorListener,
        `${WATCHER_FILE}: this.${field} is a chokidar watcher on a long-lived host with no ` +
        `.on('error', …) listener — an async watcher error would throw and kill the process`,
      ).toBe(true);
    }
  });

  it('the number of error listeners is at least the number of chokidar watchers', () => {
    // Backstop for a new watcher that does not use the `this.<field> =` shape.
    const src = fileText(WATCHER_FILE);
    const watches = (src.match(/chokidar\.watch\(/g) ?? []).length;
    const errorListeners = (src.match(/\.on\('error'/g) ?? []).length;
    expect(
      errorListeners,
      `${WATCHER_FILE}: ${watches} chokidar.watch site(s) but only ${errorListeners} 'error' listener(s)`,
    ).toBeGreaterThanOrEqual(watches);
  });

  it("the telemetry --live tail attaches an 'error' handler to its read stream", () => {
    const TAIL_FILE = 'src/cli/commands/telemetry.ts';
    const src = fileText(TAIL_FILE);
    // Isolate the tail function that runs for the lifetime of --live.
    const start = src.indexOf('export function tailTelemetryFile');
    expect(start, 'tailTelemetryFile not found — did the live tail get renamed?').toBeGreaterThanOrEqual(0);
    const end = src.indexOf('\nfunction renderLive', start);
    const body = src.slice(start, end > start ? end : undefined);
    expect(body).toContain('createReadStream(');
    expect(
      body.includes("stream.on('error'"),
      `${TAIL_FILE}: tailTelemetryFile opens a read stream with no stream.on('error') handler — ` +
      `a stream error would crash the --live session`,
    ).toBe(true);
  });
});

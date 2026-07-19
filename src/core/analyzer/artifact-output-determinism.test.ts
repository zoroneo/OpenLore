/**
 * Artifact output determinism (change: fix-artifact-output-determinism).
 *
 * Concurrent extractors that fan out over files must aggregate their results in
 * INPUT (file-list) order, not I/O-completion order — otherwise the serialized
 * bytes (route inventory, env inventory, synthesized edges) drift run to run and
 * the byte-determinism doctrine (decision c6d1ad07) is violated at the output
 * boundary. These tests stub readFile with ADVERSARIAL delays (later files resolve
 * FIRST) so a completion-order aggregator would produce reversed output; the fix's
 * `Promise.all(...).flat()` must still yield input order.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
import { buildRouteInventory } from './http-route-parser.js';
import { extractEnvVars } from './env-extractor.js';

const mockReadFile = readFile as ReturnType<typeof vi.fn>;

/**
 * Resolve each path's content after a delay that DECREASES with input index, so
 * the last file in the list resolves first — completion order is the reverse of
 * input order. `index` is the file's position in the caller's `filePaths` array.
 */
function withReversedCompletion(contentByPath: Map<string, string>, order: string[]): void {
  mockReadFile.mockImplementation((p: string) => {
    const content = contentByPath.get(p) ?? '';
    const idx = order.indexOf(p);
    const delayMs = (order.length - Math.max(idx, 0)) * 3; // first file waits longest
    return new Promise(resolve => setTimeout(() => resolve(content), delayMs));
  });
}

describe('buildRouteInventory — input-order aggregation', () => {
  beforeEach(() => mockReadFile.mockReset());

  it('orders routes by file-list order under adversarial completion latency', async () => {
    // Three FastAPI files, each with one distinct route.
    const files = ['/root/a.py', '/root/b.py', '/root/c.py'];
    const contents = new Map([
      [files[0], '@app.get("/alpha")\ndef alpha():\n    pass\n'],
      [files[1], '@app.get("/bravo")\ndef bravo():\n    pass\n'],
      [files[2], '@app.get("/charlie")\ndef charlie():\n    pass\n'],
    ]);
    withReversedCompletion(contents, files);

    const inv = await buildRouteInventory(files, '/root');
    expect(inv.routes.map(r => r.path)).toEqual(['/alpha', '/bravo', '/charlie']);
  });

  it('is byte-stable across repeated runs regardless of completion timing', async () => {
    const files = ['/root/x.py', '/root/y.py', '/root/z.py'];
    const contents = new Map([
      [files[0], '@app.post("/x1")\ndef x1():\n    pass\n'],
      [files[1], '@app.get("/y1")\ndef y1():\n    pass\n'],
      [files[2], '@app.put("/z1")\ndef z1():\n    pass\n'],
    ]);

    const runs: string[] = [];
    for (let i = 0; i < 4; i++) {
      withReversedCompletion(contents, files);
      const inv = await buildRouteInventory(files, '/root');
      runs.push(JSON.stringify(inv.routes.map(r => `${r.method} ${r.path}`)));
    }
    expect(new Set(runs).size).toBe(1);
    expect(JSON.parse(runs[0])).toEqual(['POST /x1', 'GET /y1', 'PUT /z1']);
  });
});

describe('extractEnvVars — input-order aggregation', () => {
  beforeEach(() => mockReadFile.mockReset());

  it("orders a var's files[] by file-list order under adversarial latency", async () => {
    // Same var read in three source files, listed a → b → c.
    const files = ['/root/a.ts', '/root/b.ts', '/root/c.ts'];
    const contents = new Map([
      [files[0], 'const a = process.env.SHARED;\n'],
      [files[1], 'const b = process.env.SHARED;\n'],
      [files[2], 'const c = process.env.SHARED;\n'],
    ]);
    withReversedCompletion(contents, files);

    const vars = await extractEnvVars(files, '/root');
    const shared = vars.find(v => v.name === 'SHARED');
    expect(shared?.files).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('resolves the first-wins description by file-list order, not read order', async () => {
    // Two declaration files describe the SAME var differently; the FIRST in the
    // list must win even though it resolves LAST.
    const files = ['/root/.env.example', '/root/.env.local'];
    const contents = new Map([
      [files[0], 'TOKEN= # description from example\n'],
      [files[1], 'TOKEN= # description from local\n'],
    ]);
    withReversedCompletion(contents, files);

    const vars = await extractEnvVars(files, '/root');
    const token = vars.find(v => v.name === 'TOKEN');
    expect(token?.description).toBe('description from example');
    expect(token?.files).toEqual(['.env.example', '.env.local']);
  });
});

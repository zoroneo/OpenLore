/**
 * E2E — inline <script> JS reaches the call graph through the real analyze
 * pipeline (decision 5b38bad2).
 *
 * Unlike the unit tests (which call CallGraphBuilder.build directly with
 * pre-blanked content), this drives the WHOLE pipeline on a temp repo on disk:
 * RepositoryMapper → DependencyGraphBuilder → AnalysisArtifactGenerator, which
 * is where the `.html` branch in artifact-generator actually fires. It proves
 * the wiring end-to-end: an inline-script function in an .html file on disk
 * becomes a call-graph node anchored to that file with correct line numbers.
 *
 * No embedding server needed — we inspect the call graph in the returned
 * artifacts, which is built before (and independently of) the vector index.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAnalysis } from '../../cli/commands/analyze.js';

let tmpDir: string;
let outDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'openlore-html-e2e-'));
  outDir = join(tmpDir, '.openlore', 'analysis');
  await mkdir(outDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('E2E: inline <script> JS in the analyze pipeline', () => {
  it('indexes an inline-script function as an HTML-anchored call-graph node', async () => {
    // Markup ABOVE the script so the line offsets are non-trivial.
    const html = [
      '<!DOCTYPE html>',        // 1
      '<html>',                 // 2
      '  <body>',               // 3
      '    <h1>Demo</h1>',      // 4
      '    <script>',           // 5
      '      function greet() {',// 6
      '        render();',       // 7
      '      }',                 // 8
      '      function render() {}', // 9
      '    </script>',          // 10
      '  </body>',              // 11
      '</html>',                // 12
    ].join('\n');
    await writeFile(join(tmpDir, 'index.html'), html, 'utf-8');
    // A trivial source file so the repo isn't empty.
    await writeFile(join(tmpDir, 'noop.ts'), 'export const x = 1;\n', 'utf-8');

    const { artifacts } = await runAnalysis(tmpDir, outDir, {
      maxFiles: 100,
      include: [],
      exclude: [],
    });

    const cg = artifacts.llmContext?.callGraph;
    expect(cg).toBeTruthy();
    const nodes = cg!.nodes;

    const greet = nodes.find((n) => n.name === 'greet');
    const render = nodes.find((n) => n.name === 'render');
    expect(greet, 'inline-script function greet should be a call-graph node').toBeDefined();
    expect(render).toBeDefined();

    // Anchored to the HTML file, with line numbers mapped through the markup.
    expect(greet!.filePath).toMatch(/index\.html$/);
    expect(greet!.startLine).toBe(6);
    expect(render!.startLine).toBe(9);

    // greet → render edge resolved within the inline script.
    expect(cg!.edges.some((e) => e.callerId === greet!.id && e.calleeId === render!.id)).toBe(true);
  });

  it('an .html file with no inline JS contributes no nodes and does not error', async () => {
    await writeFile(
      join(tmpDir, 'static.html'),
      '<html><body><p>no scripts here</p></body></html>\n',
      'utf-8',
    );
    await writeFile(join(tmpDir, 'noop.ts'), 'export const y = 2;\n', 'utf-8');

    const { artifacts } = await runAnalysis(tmpDir, outDir, { maxFiles: 100, include: [], exclude: [] });
    const cg = artifacts.llmContext?.callGraph;
    expect(cg).toBeTruthy();
    expect(cg!.nodes.some((n) => n.filePath.endsWith('static.html'))).toBe(false);
  });
});

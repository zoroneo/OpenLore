import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph, type FunctionNode } from './call-graph.js';
import { exportScip, type ExportReport } from '../scip/index.js';
import { buildManifest, type ManifestInputs } from '../../cli/manifest/emit.js';

const dir = join(__dirname, 'fixtures');
const load = (rel: string, language: string) => ({ path: rel, content: readFileSync(join(dir, rel), 'utf-8'), language });

describe('spec-08 cross-cutting interop (SCIP + manifest, zero tool changes)', () => {
  it('SCIP export emits new-language nodes without error; no-enum langs → UnspecifiedLanguage', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      load('polyglot/svc.cs', 'C#'),   // C# has a SCIP enum (CSharp)
      load('polyglot/deploy.sh', 'Bash'), // Bash has none → UnspecifiedLanguage
    ]));
    const report: ExportReport = {
      documentCount: 0, occurrenceCount: 0, symbolCount: 0,
      definitionCount: 0, unspecifiedLanguageFiles: [], warnings: [],
    };
    const buf = exportScip(g, {
      projectRoot: dir,
      package: { manager: 'npm', name: 'polyglot', version: '1.0.0' },
      toolVersion: '9.9.9',
      report,
    });
    expect(buf.byteLength).toBeGreaterThan(0);
    expect(report.documentCount).toBeGreaterThan(0);
    // The Bash file (no SCIP Language enum) is recorded as UnspecifiedLanguage.
    expect(report.unspecifiedLanguageFiles).toContain('polyglot/deploy.sh');
  });

  it('federation manifest languages[] includes the new language tags', () => {
    const node = (id: string, name: string, filePath: string, language: string): FunctionNode => ({
      id, name, filePath, isAsync: false, language, startIndex: 0, endIndex: 0,
      fanIn: 0, fanOut: 0, startLine: 1, cyclomaticComplexity: 1, communityId: 'c1',
    });
    const graph: SerializedCallGraph = {
      nodes: [
        node('a.cs::A', 'A', 'a.cs', 'C#'),
        node('b.kt::B', 'B', 'b.kt', 'Kotlin'),
        node('c.ex::C', 'C', 'c.ex', 'Elixir'),
      ],
      edges: [], classes: [], inheritanceEdges: [], hubFunctions: [], entryPoints: [],
      layerViolations: [], stats: { totalNodes: 3, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
    };
    const inputs: ManifestInputs = {
      projectRoot: '/repo', graph, exportsByFile: new Map(), routes: [],
      pkg: { name: 'demo' }, specCount: 0,
      git: { remote: 'git@github.com:acme/demo.git', commit: 'abc1234', defaultBranch: 'main', committedAt: '2026-05-01T00:00:00Z' },
      toolVersion: '9.9.9', hasDocs: false,
    };
    const manifest = buildManifest(inputs, {});
    const langNames = manifest.languages.map(l => l.name);
    expect(langNames).toContain('c#');
    expect(langNames).toContain('kotlin');
    expect(langNames).toContain('elixir');
  });
});

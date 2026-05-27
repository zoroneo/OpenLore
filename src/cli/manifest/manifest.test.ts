/**
 * Federation manifest emitter tests. `buildManifest` is pure (all I/O is done
 * by its caller), so these run against synthetic inputs and assert that the
 * emitted manifest validates against the real shipped JSON Schema.
 */

import { describe, it, expect } from 'vitest';
import type { FunctionNode, ClassNode, SerializedCallGraph } from '../../core/analyzer/call-graph.js';
import { buildManifest, serializeManifest, type ManifestInputs } from './emit.js';
import { validateManifest } from './validate.js';
import { validateAgainstSchema } from './schema-validator.js';
import type { ExportEntry } from './detect/public-symbols.js';

function fn(partial: Partial<FunctionNode> & { id: string; name: string; filePath: string }): FunctionNode {
  return {
    isAsync: false,
    language: 'TypeScript',
    startIndex: 0,
    endIndex: 0,
    fanIn: 0,
    fanOut: 0,
    startLine: 1,
    cyclomaticComplexity: 1,
    communityId: 'c1',
    ...partial,
  };
}

function makeGraph(nodes: FunctionNode[], classes: ClassNode[] = []): SerializedCallGraph {
  return {
    nodes,
    edges: [],
    classes,
    inheritanceEdges: [],
    hubFunctions: [],
    entryPoints: [],
    layerViolations: [],
    stats: { totalNodes: nodes.length, totalEdges: 0, avgFanIn: 0, avgFanOut: 0 },
  };
}

function makeInputs(overrides: Partial<ManifestInputs> = {}): ManifestInputs {
  const nodes = [
    fn({ id: 'src/api/index.ts::publicFn', name: 'publicFn', filePath: 'src/api/index.ts', startLine: 10, cyclomaticComplexity: 3 }),
    fn({ id: 'src/internal/helper.ts::secretFn', name: 'secretFn', filePath: 'src/internal/helper.ts', startLine: 5, cyclomaticComplexity: 7 }),
  ];
  const exportsByFile = new Map<string, ExportEntry[]>([
    ['src/api/index.ts', [{ name: 'publicFn', kind: 'function', line: 10, isReExport: false }]],
    ['src/internal/helper.ts', [{ name: 'secretFn', kind: 'function', line: 5, isReExport: false }]],
  ]);
  return {
    projectRoot: '/repo',
    graph: makeGraph(nodes),
    exportsByFile,
    routes: [{ method: 'post', path: '/api/refund', framework: 'express', file: 'src/api/refund.ts', handler: 'handleRefund' }],
    pkg: { name: 'demo', main: 'dist/api/index.js', dependencies: { stripe: '^14.0.0', chalk: '^5.0.0' } },
    specCount: 3,
    git: { remote: 'git@github.com:acme/demo.git', commit: 'abc1234', defaultBranch: 'main', committedAt: '2026-05-01T00:00:00Z' },
    toolVersion: '9.9.9',
    hasDocs: true,
    ...overrides,
  };
}

describe('buildManifest', () => {
  it('emits a manifest that validates against the shipped JSON Schema', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('is deterministic (byte-identical) for identical inputs', () => {
    const a = serializeManifest(buildManifest(makeInputs(), {}));
    const b = serializeManifest(buildManifest(makeInputs(), {}));
    expect(a).toBe(b);
  });

  it('uses the HEAD commit date as generated_at (not wall-clock)', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(manifest.generated_at).toBe('2026-05-01T00:00:00Z');
  });

  it('defaults public_symbols to the package entry point only', () => {
    const manifest = buildManifest(makeInputs(), {});
    const names = manifest.exports.public_symbols.map(s => s.name);
    expect(names).toContain('publicFn');
    expect(names).not.toContain('secretFn'); // exported, but not from the entry point
  });

  it('--include-private widens the surface to every export + function', () => {
    const manifest = buildManifest(makeInputs(), { includePrivate: true });
    const names = manifest.exports.public_symbols.map(s => s.name);
    expect(names).toContain('publicFn');
    expect(names).toContain('secretFn');
  });

  it('--max-symbols truncates and sets the truncated flag', () => {
    const manifest = buildManifest(makeInputs(), { includePrivate: true, maxSymbols: 1 });
    expect(manifest.exports.public_symbols).toHaveLength(1);
    expect(manifest.exports.truncated).toBe(true);
    expect(validateManifest(manifest)).toEqual([]);
  });

  it('omits the truncated flag when under the limit', () => {
    const manifest = buildManifest(makeInputs(), { maxSymbols: 100 });
    expect(manifest.exports.truncated).toBeUndefined();
  });

  it('resolves entry-point re-exports to their definition file + line via the call graph', () => {
    const nodes = [fn({ id: 'src/api/init.ts::openloreInit', name: 'openloreInit', filePath: 'src/api/init.ts', startLine: 41 })];
    const exportsByFile = new Map<string, ExportEntry[]>([
      ['src/api/index.ts', [{ name: 'openloreInit', kind: 'unknown', line: 1, isReExport: true, reExportSource: './init.js' }]],
      ['src/api/init.ts', []], // extractor recorded no exports for the target (real-world case)
    ]);
    const manifest = buildManifest(makeInputs({ graph: makeGraph(nodes), exportsByFile }), {});
    expect(manifest.exports.public_symbols).toContainEqual({
      name: 'openloreInit',
      kind: 'function',
      file: 'src/api/init.ts',
      line: 41,
    });
  });

  it('computes stats and languages from non-external nodes', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(manifest.stats.functions).toBe(2);
    expect(manifest.stats.files).toBe(2);
    expect(manifest.stats.avg_mccabe).toBe(5); // (3 + 7) / 2
    expect(manifest.languages).toEqual([{ name: 'typescript', files: 2, functions: 2 }]);
  });

  it('maps http routes to method/path/handler and external packages from package.json', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(manifest.exports.http_routes).toEqual([
      { method: 'POST', path: '/api/refund', handler: 'src/api/refund.ts:handleRefund' },
    ]);
    expect(manifest.imports.external_packages).toEqual([
      { name: 'chalk', version_range: '^5.0.0' },
      { name: 'stripe', version_range: '^14.0.0' },
    ]);
  });

  it('normalizes the git remote to a web URL and links docs', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(manifest.links.repo).toBe('https://github.com/acme/demo');
    expect(manifest.links.docs).toBe('https://github.com/acme/demo/tree/main/docs');
  });

  it('emits empty events/rpc arrays (analyzer does not surface them yet)', () => {
    const manifest = buildManifest(makeInputs(), {});
    expect(manifest.exports.events_emitted).toEqual([]);
    expect(manifest.exports.events_consumed).toEqual([]);
    expect(manifest.exports.rpc_endpoints).toEqual([]);
  });
});

describe('schema-validator', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['v', 'kind'],
    properties: {
      v: { const: 1 },
      kind: { type: 'string', enum: ['a', 'b'] },
      count: { type: 'integer' },
      tags: { type: 'array', items: { type: 'string' } },
      note: { type: ['string', 'null'] },
    },
  };

  it('passes a valid object', () => {
    expect(validateAgainstSchema({ v: 1, kind: 'a', count: 2, tags: ['x'], note: null }, schema)).toEqual([]);
  });

  it('flags a wrong const', () => {
    expect(validateAgainstSchema({ v: 2, kind: 'a' }, schema).some(e => /const/.test(e.message))).toBe(true);
  });

  it('flags a missing required property', () => {
    expect(validateAgainstSchema({ v: 1 }, schema).some(e => e.path === '/kind')).toBe(true);
  });

  it('flags an enum violation, a bad type, and an additional property', () => {
    const errors = validateAgainstSchema({ v: 1, kind: 'z', count: 1.5, extra: true }, schema);
    expect(errors.some(e => /enum/.test(e.message))).toBe(true);
    expect(errors.some(e => e.path === '/count')).toBe(true); // 1.5 is not integer
    expect(errors.some(e => e.path === '/extra')).toBe(true);
  });

  it('validates array items', () => {
    expect(validateAgainstSchema({ v: 1, kind: 'a', tags: ['ok', 3] }, schema).some(e => e.path === '/tags/1')).toBe(true);
  });
});

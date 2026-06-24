import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractBicep } from './bicep.js';
import { projectIacGraph } from './project.js';
import { detectLanguage } from '../signature-extractor.js';
import type { IacGraph } from './types.js';

const dir = join(__dirname, 'fixtures', 'bicep');
const mainPath = 'infra/main.bicep';
const netPath = 'infra/modules/network.bicep';

function buildFromFixtures(): IacGraph {
  return extractBicep([
    { path: mainPath, content: readFileSync(join(dir, 'main.bicep'), 'utf-8'), language: 'Bicep' },
    { path: netPath, content: readFileSync(join(dir, 'modules', 'network.bicep'), 'utf-8'), language: 'Bicep' },
  ]);
}

const hasRef = (g: IacGraph, from: string, to: string, kind?: 'references' | 'depends_on') =>
  g.references.some(
    (r) => r.fromAddress === `${from}` && r.toAddress === `${to}` && (kind ? r.kind === kind : true),
  );
const A = (file: string, sym: string) => `${file}::${sym}`;

describe('extractBicep — declarations → nodes', () => {
  const g = buildFromFixtures();
  const byAddr = (a: string) => g.resources.find((r) => r.address === a);

  it('captures every declaration kind with the right type/kind', () => {
    expect(byAddr(A(mainPath, 'location'))).toMatchObject({ kind: 'variable', type: 'parameter', language: 'Bicep' });
    expect(byAddr(A(mainPath, 'prefix'))).toMatchObject({ kind: 'value', type: 'variable' });
    expect(byAddr(A(mainPath, 'stg'))).toMatchObject({ kind: 'resource', type: 'Microsoft.Storage/storageAccounts' });
    expect(byAddr(A(mainPath, 'storageId'))).toMatchObject({ kind: 'output', type: 'output' });
    expect(byAddr(A(mainPath, 'network'))).toMatchObject({ kind: 'module' });
  });

  it('strips the @apiVersion from the resource type', () => {
    expect(byAddr(A(mainPath, 'stg'))!.type).toBe('Microsoft.Storage/storageAccounts');
    expect(byAddr(A(mainPath, 'app'))!.type).toBe('Microsoft.Web/sites');
  });

  it('marks `existing` resources as kind data', () => {
    expect(byAddr(A(mainPath, 'existingKv'))).toMatchObject({ kind: 'data', type: 'Microsoft.KeyVault/vaults' });
  });

  it('emits a single node for a loop and notes it in the signature', () => {
    const farm = byAddr(A(mainPath, 'farm'));
    expect(farm).toBeDefined();
    expect(farm!.signature).toContain('loop: single node');
    expect(g.resources.filter((r) => r.address === A(mainPath, 'farm'))).toHaveLength(1);
  });

  it('keeps the displayName a bare symbol while the address is file-scoped', () => {
    const stg = byAddr(A(mainPath, 'stg'))!;
    expect(stg.displayName).toBe('stg');
    expect(stg.address).toBe('infra/main.bicep::stg');
  });
});

describe('extractBicep — references → edges', () => {
  const g = buildFromFixtures();

  it('links var interpolation to the symbols it references', () => {
    expect(hasRef(g, A(mainPath, 'fullName'), A(mainPath, 'prefix'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'fullName'), A(mainPath, 'storageName'), 'references')).toBe(true);
  });

  it('links a resource to symbols used in its properties', () => {
    expect(hasRef(g, A(mainPath, 'stg'), A(mainPath, 'fullName'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'stg'), A(mainPath, 'location'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'app'), A(mainPath, 'existingKv'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'app'), A(mainPath, 'stg'), 'references')).toBe(true);
  });

  it('links a nested child resource to its parent', () => {
    expect(hasRef(g, A(mainPath, 'blob'), A(mainPath, 'stg'), 'references')).toBe(true);
  });

  it('does NOT emit a reversed parent→child edge', () => {
    expect(hasRef(g, A(mainPath, 'stg'), A(mainPath, 'blob'))).toBe(false);
  });

  it('emits dependsOn as a depends_on edge', () => {
    expect(hasRef(g, A(mainPath, 'app'), A(mainPath, 'stg'), 'depends_on')).toBe(true);
  });

  it('links outputs to the resources they expose', () => {
    expect(hasRef(g, A(mainPath, 'storageId'), A(mainPath, 'stg'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'appName'), A(mainPath, 'app'), 'references')).toBe(true);
  });

  it('does not invent edges for built-in functions or undeclared symbols', () => {
    // `resourceGroup()`, `range()`, `i` (loop var) are not declared symbols.
    expect(g.references.some((r) => /::(resourceGroup|range|i)$/.test(r.toAddress))).toBe(false);
  });
});

describe('extractBicep — modules', () => {
  const g = buildFromFixtures();

  it('links a local module cross-file to the resources it deploys', () => {
    expect(hasRef(g, A(mainPath, 'network'), A(netPath, 'vnet'), 'depends_on')).toBe(true);
    expect(hasRef(g, A(mainPath, 'network'), A(netPath, 'subnet'), 'depends_on')).toBe(true);
    const mod = g.modules.find((m) => m.address === A(mainPath, 'network'));
    expect(mod).toBeDefined();
    expect(mod!.members).toEqual(expect.arrayContaining([A(netPath, 'vnet'), A(netPath, 'subnet')]));
  });

  it('marks a registry module external with no invented edges', () => {
    const shared = g.resources.find((r) => r.address === A(mainPath, 'shared'));
    expect(shared).toMatchObject({ kind: 'module', isExternal: true });
    expect(g.modules.some((m) => m.address === A(mainPath, 'shared'))).toBe(false);
    expect(g.references.some((r) => r.fromAddress === A(mainPath, 'shared'))).toBe(false);
  });

  it('links module params to same-file symbols', () => {
    expect(hasRef(g, A(mainPath, 'network'), A(mainPath, 'location'), 'references')).toBe(true);
    expect(hasRef(g, A(mainPath, 'network'), A(mainPath, 'prefix'), 'references')).toBe(true);
  });
});

describe('extractBicep — file-scoped resolution', () => {
  const g = buildFromFixtures();

  it('resolves the same symbol name within each file, never across', () => {
    // Both files declare `param location` and reference it. Each must stay local.
    expect(hasRef(g, A(netPath, 'vnet'), A(netPath, 'location'), 'references')).toBe(true);
    // main's resources never point at network's location, and vice versa.
    expect(g.references.some((r) => r.fromAddress.startsWith(`${mainPath}::`) && r.toAddress === A(netPath, 'location'))).toBe(false);
    expect(g.references.some((r) => r.fromAddress.startsWith(`${netPath}::`) && r.toAddress === A(mainPath, 'location'))).toBe(false);
  });
});

describe('extractBicep — determinism & projection', () => {
  it('produces an identical graph across runs', () => {
    const a = buildFromFixtures();
    const b = buildFromFixtures();
    const norm = (g: IacGraph) => ({
      nodes: g.resources.map((r) => r.address).sort(),
      edges: g.references.map((r) => `${r.fromAddress}\0${r.toAddress}\0${r.kind}`).sort(),
    });
    expect(norm(a)).toEqual(norm(b));
  });

  it('projects onto graph primitives with clean names and unique ids', () => {
    const p = projectIacGraph(buildFromFixtures());
    const stg = p.nodes.find((n) => n.name === 'stg' && n.filePath === mainPath);
    expect(stg).toBeDefined();
    expect(stg!.language).toBe('Bicep');
    // Two files both have a `location` node — distinct ids, same readable name.
    const locs = p.nodes.filter((n) => n.name === 'location');
    expect(locs.length).toBe(2);
    expect(new Set(locs.map((n) => n.id)).size).toBe(2);
    // Local module became a module ClassNode.
    expect(p.classes.some((c) => c.name === 'network' && c.isModule)).toBe(true);
  });
});

describe('extractBicep — robustness', () => {
  it('ignores keywords inside strings and comments', () => {
    const content = [
      "// resource fake 'X' = { }",
      "var note = 'this resource param output is just text'",
      "param real string",
    ].join('\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    const addrs = g.resources.map((r) => r.address);
    expect(addrs).toContain('x.bicep::note');
    expect(addrs).toContain('x.bicep::real');
    expect(addrs).not.toContain('x.bicep::fake');
    expect(g.resources).toHaveLength(2);
  });

  it('handles a required param (no default) without a body', () => {
    const g = extractBicep([{ path: 'x.bicep', content: 'param required string\n', language: 'Bicep' }]);
    expect(g.resources.find((r) => r.address === 'x.bicep::required')).toMatchObject({ kind: 'variable' });
    expect(g.references).toHaveLength(0);
  });

  it('does not treat == / != / >= as a declaration value separator', () => {
    const content = "var flag = a == b\nparam a string\nparam b string\n";
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(hasRef(g, 'x.bicep::flag', 'x.bicep::a', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::flag', 'x.bicep::b', 'references')).toBe(true);
  });

  it('handles a conditional resource `= if (cond) { … }` with a nested child', () => {
    const content = [
      "param dep bool",
      "resource other 'Microsoft.Foo/bars@2023-01-01' = { name: 'o' }",
      "resource parent 'Microsoft.Foo/bars@2023-01-01' = if (dep) {",
      "  name: 'p'",
      "  resource child 'Microsoft.Foo/bars/bazs@2023-01-01' = {",
      "    name: 'c'",
      "    dependsOn: [ other ]",
      "  }",
      "}",
    ].join('\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    // The condition symbol is a real dependency of the conditional resource.
    expect(hasRef(g, 'x.bicep::parent', 'x.bicep::dep', 'references')).toBe(true);
    // The child gets its parent edge, and the child's dependsOn stays the CHILD's.
    expect(hasRef(g, 'x.bicep::child', 'x.bicep::parent', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::child', 'x.bicep::other', 'depends_on')).toBe(true);
    // No reversed parent→child, and the parent does NOT steal the child's dependsOn.
    expect(hasRef(g, 'x.bicep::parent', 'x.bicep::child')).toBe(false);
    expect(hasRef(g, 'x.bicep::parent', 'x.bicep::other')).toBe(false);
  });

  it('keeps both arms of a ternary as references', () => {
    const content = "param flag bool\nparam yes string\nparam no string\nvar pick = flag ? yes : no\n";
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(hasRef(g, 'x.bicep::pick', 'x.bicep::flag', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::pick', 'x.bicep::yes', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::pick', 'x.bicep::no', 'references')).toBe(true);
  });

  it('does not emit a dependsOn edge from a comment', () => {
    const content = [
      "param other string",
      "resource r 'Microsoft.Foo/bars@2023-01-01' = {",
      "  name: 'r'",
      "  // dependsOn: [ other ]",
      "}",
    ].join('\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(g.references.some((r) => r.toAddress === 'x.bicep::other')).toBe(false);
  });

  it('resolves both sides of the `::` nested-resource accessor', () => {
    const content = [
      "resource vnet 'Microsoft.Network/virtualNetworks@2023-01-01' = {",
      "  name: 'vnet'",
      "  resource subnet 'subnets' = {",
      "    name: 'default'",
      "  }",
      "}",
      "output subnetId string = vnet::subnet.id",
    ].join('\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    // `vnet::subnet` depends on both the parent and the nested child.
    expect(hasRef(g, 'x.bicep::subnetId', 'x.bicep::vnet', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::subnetId', 'x.bicep::subnet', 'references')).toBe(true);
  });

  it('resolves spread sources in object and array spreads', () => {
    const content = [
      "var commonTags = { team: 'core' }",
      "var base = [ 'a' ]",
      "var extra = 'b'",
      "var tags = { ...commonTags, env: 'prod' }",
      "var arr = [ ...base, extra ]",
    ].join('\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(hasRef(g, 'x.bicep::tags', 'x.bicep::commonTags', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::arr', 'x.bicep::base', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::arr', 'x.bicep::extra', 'references')).toBe(true);
    // Member access is still excluded (regression guard for the spread fix).
    expect(g.references.some((r) => r.toAddress === 'x.bicep::env')).toBe(false);
  });

  it('still excludes plain member access after the spread fix', () => {
    const content = "param a string\nvar b = a.something.nested\n";
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(hasRef(g, 'x.bicep::b', 'x.bicep::a', 'references')).toBe(true);
    expect(g.references.some((r) => /::(something|nested)$/.test(r.toAddress))).toBe(false);
  });

  it('is unfazed by decorators and CRLF line endings', () => {
    const content = [
      "@description('the location')",
      "@allowed([",
      "  'eastus'",
      "  'westus'",
      "])",
      "param location string",
      "resource r 'Microsoft.Foo/bars@2023-01-01' = {",
      "  name: 'r'",
      "  location: location",
      "}",
    ].join('\r\n');
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(g.resources.find((r) => r.address === 'x.bicep::location')).toMatchObject({ kind: 'variable' });
    expect(hasRef(g, 'x.bicep::r', 'x.bicep::location', 'references')).toBe(true);
    // Decorators must not get absorbed into the node's line range as a bogus extra node.
    expect(g.resources.filter((r) => r.address.startsWith('x.bicep::')).map((r) => r.address).sort())
      .toEqual(['x.bicep::location', 'x.bicep::r']);
  });

  it('resolves forward references (declaration order is irrelevant)', () => {
    // `url` references `foo` declared AFTER it; `foo` references `bar`, also later.
    const content = 'output url string = foo\nvar foo = bar\nvar bar = 1\n';
    const g = extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }]);
    expect(hasRef(g, 'x.bicep::url', 'x.bicep::foo', 'references')).toBe(true);
    expect(hasRef(g, 'x.bicep::foo', 'x.bicep::bar', 'references')).toBe(true);
  });

  it('never crashes on empty, comment-only, or truncated/malformed input', () => {
    const inputs = [
      '',
      '   \n\t\n',
      '// just a comment\n/* block */\n',
      "var x = '${a", // unterminated interpolation + string
      "resource r 'T@1' = {\n  name: 'x'", // unterminated brace
      "var y = '${foo'\nvar foo = 1", // unterminated string mid-interp
    ];
    for (const content of inputs) {
      expect(() => extractBicep([{ path: 'x.bicep', content, language: 'Bicep' }])).not.toThrow();
    }
  });

  it('does not classify `.bicepparam` as Bicep (parameter files are out of scope)', () => {
    // Guards against broadening the `.bicep` extension match to swallow `.bicepparam`,
    // which would feed a different grammar into the resource extractor.
    expect(detectLanguage('main.bicepparam')).toBe('unknown');
    expect(detectLanguage('main.bicep')).toBe('Bicep');
  });
});

import { describe, it, expect } from 'vitest';
import { extractGitHubActions, isWorkflowPath, isActionMetadataPath } from './github-actions.js';

const ci = [
  'name: CI',
  'on: [push, pull_request]',
  'jobs:',
  '  build:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - uses: ./.github/actions/setup',
  '      - run: npm run build',
  '  test:',
  '    needs: build',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '  deploy:',
  '    needs: [build, test]',
  '    uses: ./.github/workflows/reusable.yml',
].join('\n');

const reusable = [
  'name: Reusable',
  'on: workflow_call',
  'jobs:',
  '  do:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - run: echo hi',
].join('\n');

const setupAction = [
  'name: Setup',
  'runs:',
  '  using: composite',
  '  steps:',
  '    - uses: actions/setup-node@v4',
  '    - uses: ./.github/actions/inner',
].join('\n');

const innerAction = [
  'name: Inner',
  'runs:',
  '  using: node20',
  '  main: index.js',
].join('\n');

const files = [
  { path: '.github/workflows/ci.yml', content: ci },
  { path: '.github/workflows/reusable.yml', content: reusable },
  { path: '.github/actions/setup/action.yml', content: setupAction },
  { path: '.github/actions/inner/action.yml', content: innerAction },
];

describe('GitHub Actions extraction', () => {
  const graph = extractGitHubActions(files);
  const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
  const addrs = graph.resources.map(r => r.address);

  it('classifies workflow vs action paths', () => {
    expect(isWorkflowPath('.github/workflows/ci.yml')).toBe(true);
    expect(isWorkflowPath('.github/workflows/ci.yaml')).toBe(true);
    expect(isWorkflowPath('foo/.github/workflows/x.yml')).toBe(true);
    expect(isWorkflowPath('config/ci.yml')).toBe(false);
    expect(isActionMetadataPath('.github/actions/setup/action.yml')).toBe(true);
    expect(isActionMetadataPath('action.yaml')).toBe(true);
    expect(isActionMetadataPath('actions.yml')).toBe(false);
  });

  it('creates a workflow handle node carrying triggers, plus one node per job', () => {
    expect(addrs).toContain('.github/workflows/ci.yml::workflow');
    const wf = graph.resources.find(r => r.address === '.github/workflows/ci.yml::workflow')!;
    expect(wf.type).toBe('workflow');
    expect(wf.signature).toBe('workflow CI on [push, pull_request]');
    expect(addrs).toContain('.github/workflows/ci.yml::job.build');
    expect(addrs).toContain('.github/workflows/ci.yml::job.test');
    expect(addrs).toContain('.github/workflows/ci.yml::job.deploy');
  });

  it('resolves needs → job→job depends_on edges (string and list form)', () => {
    expect(refs).toContain('.github/workflows/ci.yml::job.test -depends_on-> .github/workflows/ci.yml::job.build');
    expect(refs).toContain('.github/workflows/ci.yml::job.deploy -depends_on-> .github/workflows/ci.yml::job.build');
    expect(refs).toContain('.github/workflows/ci.yml::job.deploy -depends_on-> .github/workflows/ci.yml::job.test');
  });

  it('resolves a step uses to an external action node (deduped by ref)', () => {
    expect(refs).toContain('.github/workflows/ci.yml::job.build -references-> actions/checkout@v4');
    expect(refs).toContain('.github/workflows/ci.yml::job.test -references-> actions/checkout@v4');
    const checkout = graph.resources.filter(r => r.address === 'actions/checkout@v4');
    expect(checkout).toHaveLength(1);
    expect(checkout[0].isExternal).toBe(true);
  });

  it('resolves a local step uses to the composite action it builds (cross-file)', () => {
    expect(refs).toContain('.github/workflows/ci.yml::job.build -references-> .github/actions/setup/action.yml::action');
    const setup = graph.resources.find(r => r.address === '.github/actions/setup/action.yml::action')!;
    expect(setup.type).toBe('composite-action');
  });

  it('resolves a job-level reusable workflow uses to the target workflow handle (cross-file)', () => {
    expect(refs).toContain('.github/workflows/ci.yml::job.deploy -references-> .github/workflows/reusable.yml::workflow');
  });

  it('resolves composite action nested uses (action→action and action→external)', () => {
    expect(refs).toContain('.github/actions/setup/action.yml::action -references-> actions/setup-node@v4');
    expect(refs).toContain('.github/actions/setup/action.yml::action -references-> .github/actions/inner/action.yml::action');
    const inner = graph.resources.find(r => r.address === '.github/actions/inner/action.yml::action')!;
    expect(inner.type).toBe('action'); // using: node20 → not composite
  });

  it('answers analyze_impact: who breaks if actions/checkout@v4 moves?', () => {
    const dependents = graph.references
      .filter(r => r.toAddress === 'actions/checkout@v4')
      .map(r => r.fromAddress)
      .sort();
    expect(dependents).toEqual([
      '.github/workflows/ci.yml::job.build',
      '.github/workflows/ci.yml::job.test',
    ]);
  });

  it('emits no edge for a dynamic ${{ }} uses', () => {
    const dyn = extractGitHubActions([{
      path: '.github/workflows/m.yml',
      content: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: ${{ matrix.action }}',
      ].join('\n'),
    }]);
    expect(dyn.references).toHaveLength(0);
    // the dynamic ref must not have minted an external node either
    expect(dyn.resources.some(r => r.isExternal)).toBe(false);
  });

  it('emits no edge for a local uses whose target is not indexed', () => {
    const orphan = extractGitHubActions([{
      path: '.github/workflows/o.yml',
      content: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: ./.github/actions/missing',
      ].join('\n'),
    }]);
    expect(orphan.references).toHaveLength(0);
  });

  it('survives a flow-mapping with ${{ }} (masks expressions) and keeps downstream jobs', () => {
    // `with: { x: ${{ … }} }` is valid GitHub syntax but breaks strict YAML 1.2 flow parsing;
    // without masking the parse desyncs and silently drops every job after it.
    const g = extractGitHubActions([{
      path: '.github/workflows/m.yml',
      content: [
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with: { node-version: ${{ matrix.node }} }',
        '      - uses: ./.github/actions/build',
        '  release:',
        '    needs: build',
        '    uses: ./.github/workflows/rel.yml',
      ].join('\n'),
    }, {
      path: '.github/workflows/rel.yml',
      content: 'on: workflow_call\njobs:\n  pub:\n    runs-on: ubuntu-latest\n    steps: []',
    }, {
      path: '.github/actions/build/action.yml',
      content: 'runs:\n  using: composite\n  steps: []',
    }]);
    const refs = g.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
    // The job AFTER the flow-`${{ }}` step must survive, with all its edges.
    expect(refs).toContain('.github/workflows/m.yml::job.build -references-> actions/checkout@v4');
    expect(refs).toContain('.github/workflows/m.yml::job.build -references-> .github/actions/build/action.yml::action');
    expect(refs).toContain('.github/workflows/m.yml::job.release -depends_on-> .github/workflows/m.yml::job.build');
    expect(refs).toContain('.github/workflows/m.yml::job.release -references-> .github/workflows/rel.yml::workflow');
  });

  it('drops a partially-templated uses (org/action@${{ version }}) — no edge, no garbage node', () => {
    const g = extractGitHubActions([{
      path: '.github/workflows/p.yml',
      content: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: my-org/my-action@${{ env.VERSION }}',
      ].join('\n'),
    }]);
    expect(g.references).toHaveLength(0);
    expect(g.resources.some(r => r.isExternal)).toBe(false);
  });

  it('expands YAML merge keys so an anchored job inherits its steps/needs edges', () => {
    const merged = extractGitHubActions([{
      path: '.github/workflows/anchored.yml',
      content: [
        'on: push',
        'jobs:',
        '  build: &base',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '  test:',
        '    <<: *base',
        '    needs: build',
      ].join('\n'),
    }]);
    const refs = merged.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
    // `test` merges build's steps via the anchor → it must carry the checkout edge too.
    expect(refs).toContain('.github/workflows/anchored.yml::job.test -references-> actions/checkout@v4');
    expect(refs).toContain('.github/workflows/anchored.yml::job.build -references-> actions/checkout@v4');
    expect(refs).toContain('.github/workflows/anchored.yml::job.test -depends_on-> .github/workflows/anchored.yml::job.build');
  });

  it('ignores recoverable-but-malformed YAML rather than minting a garbage node', () => {
    const bad = extractGitHubActions([{
      path: '.github/workflows/bad.yml',
      content: 'on: push\njobs:\n  a:\n   - : : :\n  b\n',
    }]);
    expect(bad.resources.every(r => r.filePath !== '.github/workflows/bad.yml')).toBe(true);
  });

  it('does not mint an edge from a `with:` input literally named uses', () => {
    // Only a step's top-level `uses:` is an action ref; a `with: { uses: … }` input is data.
    const g = extractGitHubActions([{
      path: '.github/workflows/w.yml',
      content: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/configure@v1',
        '        with:',
        '          uses: evil/not-an-edge@v9',
      ].join('\n'),
    }]);
    const targets = g.references.map(r => r.toAddress);
    expect(targets).toContain('actions/configure@v1');
    expect(targets).not.toContain('evil/not-an-edge@v9');
    expect(g.resources.some(r => r.address.includes('evil'))).toBe(false);
  });

  it('treats a remote reusable workflow (owner/repo/.github/workflows/x.yml@ref) as external', () => {
    const g = extractGitHubActions([{
      path: '.github/workflows/w.yml',
      content: [
        'on: push',
        'jobs:',
        '  call:',
        '    uses: octo-org/shared/.github/workflows/build.yml@v2',
      ].join('\n'),
    }]);
    expect(g.references.map(r => r.toAddress)).toContain('octo-org/shared/.github/workflows/build.yml@v2');
    const ext = g.resources.find(r => r.address === 'octo-org/shared/.github/workflows/build.yml@v2')!;
    expect(ext.isExternal).toBe(true);
  });

  it('does not mint service/container images as nodes (out of scope)', () => {
    const g = extractGitHubActions([{
      path: '.github/workflows/w.yml',
      content: [
        'on: push',
        'jobs:',
        '  a:',
        '    runs-on: ubuntu-latest',
        '    container: node:20',
        '    services:',
        '      postgres:',
        '        image: postgres:16',
        '    steps:',
        '      - uses: actions/checkout@v4',
      ].join('\n'),
    }]);
    const addrs = g.resources.map(r => r.address);
    expect(addrs).not.toContain('node:20');
    expect(addrs).not.toContain('postgres:16');
    // the real step uses edge is still present
    expect(g.references.map(r => r.toAddress)).toContain('actions/checkout@v4');
  });

  it('survives a leading `---` document start marker (common real-world)', () => {
    const g = extractGitHubActions([{
      path: '.github/workflows/w.yml',
      content: '---\non: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4',
    }]);
    expect(g.resources.some(r => r.address === '.github/workflows/w.yml::job.a')).toBe(true);
    expect(g.references.map(r => r.toAddress)).toContain('actions/checkout@v4');
  });

  it('is deterministic across runs', () => {
    const a = JSON.stringify(extractGitHubActions(files));
    const b = JSON.stringify(extractGitHubActions(files));
    expect(a).toBe(b);
  });
});

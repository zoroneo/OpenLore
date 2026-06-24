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

  it('ignores recoverable-but-malformed YAML rather than minting a garbage node', () => {
    const bad = extractGitHubActions([{
      path: '.github/workflows/bad.yml',
      content: 'on: push\njobs:\n  a:\n   - : : :\n  b\n',
    }]);
    expect(bad.resources.every(r => r.filePath !== '.github/workflows/bad.yml')).toBe(true);
  });

  it('is deterministic across runs', () => {
    const a = JSON.stringify(extractGitHubActions(files));
    const b = JSON.stringify(extractGitHubActions(files));
    expect(a).toBe(b);
  });
});

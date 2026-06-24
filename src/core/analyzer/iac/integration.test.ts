import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph } from '../call-graph.js';

const tfDir = join(__dirname, 'fixtures', 'terraform');
const bicepDir = join(__dirname, 'fixtures', 'bicep');
const k8s = readFileSync(join(__dirname, 'fixtures', 'kubernetes', 'app.yaml'), 'utf-8');

const appTs = `
export function provisionInfra(): string {
  return deployBucket();
}
function deployBucket(): string {
  return "aws_s3_bucket.logs";
}
`;

const files = [
  { path: 'src/app.ts', content: appTs, language: 'TypeScript' },
  { path: 'infra/main.tf', content: readFileSync(join(tfDir, 'main.tf'), 'utf-8'), language: 'Terraform' },
  { path: 'infra/network/vpc.tf', content: readFileSync(join(tfDir, 'network', 'vpc.tf'), 'utf-8'), language: 'Terraform' },
  { path: 'k8s/app.yaml', content: k8s, language: 'Kubernetes' },
  { path: 'infra/main.bicep', content: readFileSync(join(bicepDir, 'main.bicep'), 'utf-8'), language: 'Bicep' },
  { path: 'infra/modules/network.bicep', content: readFileSync(join(bicepDir, 'modules', 'network.bicep'), 'utf-8'), language: 'Bicep' },
];

describe('IaC ↔ existing graph integration', () => {
  it('surfaces app + infra nodes in one graph with no tool changes', async () => {
    const result = await new CallGraphBuilder().build(files);
    const graph = serializeCallGraph(result);

    // App function nodes still present.
    expect(graph.nodes.some(n => n.name === 'provisionInfra' && n.language === 'TypeScript')).toBe(true);
    // IaC nodes present, tagged by ecosystem.
    expect(graph.nodes.some(n => n.name === 'aws_s3_bucket.logs' && n.language === 'Terraform')).toBe(true);
    expect(graph.nodes.some(n => n.name === 'Deployment/web' && n.language === 'Kubernetes')).toBe(true);
    // Bicep nodes present with clean (bare-symbol) names, tagged Bicep.
    expect(graph.nodes.some(n => n.name === 'stg' && n.language === 'Bicep' && n.filePath === 'infra/main.bicep')).toBe(true);

    // analyze_impact style on a Bicep resource: who depends on `stg`?
    const stg = graph.nodes.find(n => n.name === 'stg' && n.filePath === 'infra/main.bicep')!;
    const stgDependents = graph.edges
      .filter(e => e.calleeId === stg.id)
      .map(e => graph.nodes.find(n => n.id === e.callerId)?.name);
    expect(stgDependents).toContain('app');
    expect(stgDependents).toContain('storageId');

    // Cross-file local-module edge: main's `network` module → network.bicep's `vnet`.
    const networkMod = graph.nodes.find(n => n.name === 'network' && n.filePath === 'infra/main.bicep')!;
    const vnet = graph.nodes.find(n => n.name === 'vnet' && n.filePath === 'infra/modules/network.bicep')!;
    expect(graph.edges.some(e => e.callerId === networkMod.id && e.calleeId === vnet.id)).toBe(true);

    // Spread (`allTags = { ...baseTags }`) and the `::` accessor (`stg::blob`) resolve end-to-end.
    const nodeId = (name: string) => graph.nodes.find(n => n.name === name && n.filePath === 'infra/main.bicep')?.id;
    const edge = (from?: string, to?: string) => graph.edges.some(e => e.callerId === from && e.calleeId === to);
    expect(edge(nodeId('allTags'), nodeId('baseTags'))).toBe(true);
    expect(edge(nodeId('blobName'), nodeId('stg'))).toBe(true);
    expect(edge(nodeId('blobName'), nodeId('blob'))).toBe(true);

    // infra→infra edges exist (references / depends_on).
    const iacEdges = graph.edges.filter(e => e.kind === 'references' || e.kind === 'depends_on');
    expect(iacEdges.length).toBeGreaterThan(0);

    // analyze_impact style: who depends on the bucket? (depth-1 callers)
    const bucket = graph.nodes.find(n => n.name === 'aws_s3_bucket.logs')!;
    const dependents = graph.edges
      .filter(e => e.calleeId === bucket.id)
      .map(e => graph.nodes.find(n => n.id === e.callerId)?.name);
    expect(dependents).toContain('aws_s3_bucket_policy.logs_policy');
  });

  it('is deterministic across rebuilds', async () => {
    const a = serializeCallGraph(await new CallGraphBuilder().build(files));
    const b = serializeCallGraph(await new CallGraphBuilder().build(files));
    const iac = (g: typeof a) => ({
      nodes: g.nodes.filter(n => ['Terraform', 'Kubernetes', 'Bicep'].includes(n.language)).map(n => n.id).sort(),
      edges: g.edges.filter(e => e.kind === 'references' || e.kind === 'depends_on')
        .map(e => `${e.callerId}\0${e.calleeId}\0${e.kind}`).sort(),
    });
    expect(iac(a)).toEqual(iac(b));
  });

  it('does not regress general-purpose extraction (app call edge intact)', async () => {
    const result = await new CallGraphBuilder().build(files);
    const graph = serializeCallGraph(result);
    const caller = graph.nodes.find(n => n.name === 'provisionInfra')!;
    const callee = graph.nodes.find(n => n.name === 'deployBucket')!;
    expect(graph.edges.some(e => e.callerId === caller.id && e.calleeId === callee.id)).toBe(true);
  });
});

describe('GitHub Actions workflow graph integration', () => {
  const ci = [
    'name: CI',
    'on: [push]',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - uses: ./.github/actions/setup',
    '  test:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
  ].join('\n');
  const setupAction = [
    'name: Setup',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - uses: actions/setup-node@v4',
  ].join('\n');
  const ghaFiles = [
    { path: '.github/workflows/ci.yml', content: ci, language: 'GitHub Actions' },
    { path: '.github/actions/setup/action.yml', content: setupAction, language: 'GitHub Actions' },
  ];

  it('surfaces workflow + job + action nodes in the shared graph with no tool changes', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(ghaFiles));
    expect(graph.nodes.some(n => n.name === '.github/workflows/ci.yml::workflow' && n.language === 'GitHub Actions')).toBe(true);
    expect(graph.nodes.some(n => n.name === '.github/workflows/ci.yml::job.build' && n.language === 'GitHub Actions')).toBe(true);
    expect(graph.nodes.some(n => n.name === '.github/actions/setup/action.yml::action' && n.language === 'GitHub Actions')).toBe(true);
    expect(graph.nodes.some(n => n.name === 'actions/checkout@v4' && n.isExternal)).toBe(true);
  });

  it('answers analyze_impact: who breaks if a shared action moves? (depth-1 callers)', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(ghaFiles));
    const checkout = graph.nodes.find(n => n.name === 'actions/checkout@v4')!;
    const dependents = graph.edges
      .filter(e => e.calleeId === checkout.id)
      .map(e => graph.nodes.find(n => n.id === e.callerId)?.name)
      .sort();
    expect(dependents).toEqual(['.github/workflows/ci.yml::job.build', '.github/workflows/ci.yml::job.test']);
  });

  it('links a job to the composite action it builds, and the CI needs DAG', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(ghaFiles));
    const build = graph.nodes.find(n => n.name === '.github/workflows/ci.yml::job.build')!;
    const test = graph.nodes.find(n => n.name === '.github/workflows/ci.yml::job.test')!;
    const setup = graph.nodes.find(n => n.name === '.github/actions/setup/action.yml::action')!;
    expect(graph.edges.some(e => e.callerId === build.id && e.calleeId === setup.id)).toBe(true);
    expect(graph.edges.some(e => e.callerId === test.id && e.calleeId === build.id && e.kind === 'depends_on')).toBe(true);
  });
});

describe('Docker container graph integration', () => {
  const dockerfile = [
    'FROM python:3.12-slim AS builder',
    'RUN pip install -r requirements.txt',
    'FROM python:3.12-slim',
    'COPY --from=builder /app /app',
  ].join('\n');
  const composeYaml = [
    'services:',
    '  api:',
    '    build: ./api',
    '    depends_on:',
    '      - db',
    '  db:',
    '    image: postgres:16',
  ].join('\n');
  const dockerFiles = [
    { path: 'api/Dockerfile', content: dockerfile, language: 'Dockerfile' },
    { path: 'docker-compose.yml', content: composeYaml, language: 'Docker Compose' },
  ];

  it('surfaces Dockerfile + compose nodes in the shared graph with no tool changes', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(dockerFiles));
    expect(graph.nodes.some(n => n.name === 'api/Dockerfile::builder' && n.language === 'Dockerfile')).toBe(true);
    expect(graph.nodes.some(n => n.name === 'docker-compose.yml::service.api' && n.language === 'Docker Compose')).toBe(true);
    expect(graph.nodes.some(n => n.name === 'python:3.12-slim' && n.isExternal)).toBe(true);
  });

  it('answers analyze_impact: who rebuilds if the base image moves? (depth-1 callers)', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(dockerFiles));
    const baseImage = graph.nodes.find(n => n.name === 'python:3.12-slim')!;
    const dependents = graph.edges
      .filter(e => e.calleeId === baseImage.id)
      .map(e => graph.nodes.find(n => n.id === e.callerId)?.name);
    // Both build stages depend on the base image.
    expect(dependents).toContain('api/Dockerfile::builder');
    expect(dependents).toContain('api/Dockerfile::stage1');
  });

  it('links a compose service to the Dockerfile stage it builds', async () => {
    const graph = serializeCallGraph(await new CallGraphBuilder().build(dockerFiles));
    const api = graph.nodes.find(n => n.name === 'docker-compose.yml::service.api')!;
    const finalStage = graph.nodes.find(n => n.name === 'api/Dockerfile::stage1')!;
    expect(graph.edges.some(e => e.callerId === api.id && e.calleeId === finalStage.id)).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph } from '../call-graph.js';

const tfDir = join(__dirname, 'fixtures', 'terraform');
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
      nodes: g.nodes.filter(n => ['Terraform', 'Kubernetes'].includes(n.language)).map(n => n.id).sort(),
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

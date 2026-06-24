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

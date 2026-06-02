/**
 * Spec-17 — Cross-Domain Impact Analysis (Code ↔ Infrastructure).
 *
 * Verifies the single deterministic wiring that crosses the boundary: an
 * enclosing code function gets a `references` edge to each embedded IaC resource
 * it provisions, so the unified graph can be traversed end-to-end (code→infra and
 * the reverse) with no new tooling. Offline, deterministic, over a committed fixture.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CallGraphBuilder, serializeCallGraph, type SerializedCallGraph } from '../call-graph.js';

const appTs = readFileSync(join(__dirname, 'fixtures', 'cross-domain', 'app.ts'), 'utf-8');
const files = [{ path: 'src/app.ts', content: appTs, language: 'TypeScript' }];

function nodeByName(g: SerializedCallGraph, name: string) {
  return g.nodes.find(n => n.name === name);
}

describe('cross-domain code↔infra wiring (spec-17)', () => {
  it('links the enclosing code function to the Pulumi resources it provisions', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build(files));

    const deploy = nodeByName(g, 'deployBucket');
    const bucket = nodeByName(g, 'Bucket:logs');
    const policy = nodeByName(g, 'BucketPolicy:logs-policy');
    expect(deploy).toBeDefined();
    expect(bucket?.language).toBe('Pulumi');
    expect(policy?.language).toBe('Pulumi');

    // The connecting edges: deployBucket --references--> each resource.
    const refs = g.edges.filter(e => e.callerId === deploy!.id && e.kind === 'references');
    const calleeIds = refs.map(e => e.calleeId);
    expect(calleeIds).toContain(bucket!.id);
    expect(calleeIds).toContain(policy!.id);
  });

  it('makes the code→infra blast radius reachable (handler → deploy → resources)', async () => {
    const g = serializeCallGraph(await new CallGraphBuilder().build(files));

    // Walk from the handler over calls + references, mirroring analyze_impact's BFS.
    const forward = new Map<string, Set<string>>();
    for (const e of g.edges) {
      if (!e.calleeId) continue;
      (forward.get(e.callerId) ?? forward.set(e.callerId, new Set()).get(e.callerId)!).add(e.calleeId);
    }
    const start = nodeByName(g, 'handleProvisionRequest')!;
    const seen = new Set<string>([start.id]);
    const queue = [start.id];
    while (queue.length) {
      for (const next of forward.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
    }
    const reachedInfra = [...seen]
      .map(id => g.nodes.find(n => n.id === id))
      .filter(n => n && ['Pulumi', 'CDK', 'CDKTF', 'Terraform', 'Kubernetes'].includes(n.language));
    expect(reachedInfra.map(n => n!.name).sort()).toEqual(['Bucket:logs', 'BucketPolicy:logs-policy']);
  });

  it('does not link standalone IaC (no co-located code → no cross-domain edge)', async () => {
    // A .tf file has no code functions, so no enclosing function exists to link.
    const tf = `resource "aws_s3_bucket" "logs" {}\n`;
    const g = serializeCallGraph(await new CallGraphBuilder().build([
      { path: 'infra/main.tf', content: tf, language: 'Terraform' },
    ]));
    const refs = g.edges.filter(e => e.kind === 'references');
    // No code→infra edges (the only possible references here would be infra→infra).
    const codeToInfra = refs.filter(e => {
      const caller = g.nodes.find(n => n.id === e.callerId);
      return caller && !['Terraform', 'Kubernetes', 'Pulumi', 'CDK', 'CDKTF', 'Helm', 'CloudFormation', 'Ansible'].includes(caller.language);
    });
    expect(codeToInfra).toHaveLength(0);
  });

  it('is deterministic across rebuilds', async () => {
    const cross = (g: SerializedCallGraph) =>
      g.edges
        .filter(e => e.kind === 'references')
        .map(e => `${e.callerId} ${e.calleeId}`)
        .sort();
    const a = serializeCallGraph(await new CallGraphBuilder().build(files));
    const b = serializeCallGraph(await new CallGraphBuilder().build(files));
    expect(cross(a)).toEqual(cross(b));
  });
});

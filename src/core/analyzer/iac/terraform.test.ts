import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractTerraform } from './terraform.js';
import { projectIacGraph } from './project.js';

const dir = join(__dirname, 'fixtures', 'terraform');
function load(rel: string) {
  return { path: `terraform/${rel}`, content: readFileSync(join(dir, rel), 'utf-8') };
}

describe('terraform extraction', () => {
  const graph = extractTerraform([load('main.tf'), load('network/vpc.tf')]);

  it('extracts resources, data, modules, variables, outputs, providers', () => {
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toContain('aws_s3_bucket.logs');
    expect(addrs).toContain('aws_s3_bucket_policy.logs_policy');
    expect(addrs).toContain('data.aws_iam_policy_document.logs');
    expect(addrs).toContain('module.network');
    expect(addrs).toContain('var.region');
    expect(addrs).toContain('var.bucket_name');
    expect(addrs).toContain('output.bucket_arn');
    expect(addrs).toContain('provider.aws');
    expect(addrs).toContain('aws_vpc.main');
    expect(addrs).toContain('aws_subnet.public');
  });

  it('marks provider as external', () => {
    expect(graph.resources.find(r => r.address === 'provider.aws')?.isExternal).toBe(true);
  });

  it('resolves references and depends_on edges', () => {
    const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`).sort();
    expect(refs).toContain('aws_s3_bucket_policy.logs_policy -references-> aws_s3_bucket.logs');
    expect(refs).toContain('aws_s3_bucket_policy.logs_policy -depends_on-> aws_s3_bucket.logs');
    expect(refs).toContain('aws_s3_bucket_policy.logs_policy -references-> data.aws_iam_policy_document.logs');
    expect(refs).toContain('output.bucket_arn -references-> aws_s3_bucket.logs');
    expect(refs).toContain('aws_subnet.public -references-> aws_vpc.main');
    expect(refs).toContain('aws_s3_bucket.logs -references-> var.bucket_name');
  });

  it('links a local module source to the module dir resources', () => {
    const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
    expect(refs).toContain('module.network -depends_on-> aws_vpc.main');
    expect(refs).toContain('module.network -depends_on-> aws_subnet.public');
  });

  it('parses the *.tf.json variant (resources, refs, depends_on)', () => {
    const json = extractTerraform([load('resources.tf.json')]);
    const addrs = json.resources.map(r => r.address).sort();
    expect(addrs).toContain('aws_sqs_queue.jobs');
    expect(addrs).toContain('aws_sns_topic.alerts');
    expect(addrs).toContain('aws_sns_topic_subscription.jobs_sub');
    expect(addrs).toContain('var.queue_name');
    expect(addrs).toContain('output.queue_arn');
    const refs = json.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
    expect(refs).toContain('aws_sqs_queue.jobs -references-> var.queue_name');
    expect(refs).toContain('aws_sns_topic_subscription.jobs_sub -references-> aws_sns_topic.alerts');
    expect(refs).toContain('aws_sns_topic_subscription.jobs_sub -references-> aws_sqs_queue.jobs');
    expect(refs).toContain('aws_sns_topic_subscription.jobs_sub -depends_on-> aws_sqs_queue.jobs');
    expect(refs).toContain('output.queue_arn -references-> aws_sqs_queue.jobs');
  });

  it('resolves references to resource types without an underscore (drops if unknown)', () => {
    const g = extractTerraform([{
      path: 'terraform/custom.tf',
      content: 'resource "kubernetes" "ns" {}\nresource "foo" "bar" {\n  ref = kubernetes.ns.id\n  dangling = nope.gone.x\n}\n',
    }]);
    const refs = g.references.map(r => `${r.fromAddress} -> ${r.toAddress}`);
    expect(refs).toContain('foo.bar -> kubernetes.ns');
    // Unresolved target (no such resource) is still emitted as a candidate but
    // would be dropped by the projector; assert it is not falsely a known node.
    expect(g.resources.some(r => r.address === 'nope.gone')).toBe(false);
  });

  it('projects onto FunctionNode/CallEdge with blast-radius direction', () => {
    const projected = projectIacGraph(graph);
    // analyze_impact on a base resource: who depends on aws_s3_bucket.logs?
    const bucket = projected.nodes.find(n => n.name === 'aws_s3_bucket.logs')!;
    const dependents = projected.edges.filter(e => e.calleeId === bucket.id).map(e => {
      return projected.nodes.find(n => n.id === e.callerId)?.name;
    });
    expect(dependents).toContain('aws_s3_bucket_policy.logs_policy');
    expect(dependents).toContain('output.bucket_arn');
    expect(bucket.language).toBe('Terraform');
    expect(bucket.className).toBe('aws_s3_bucket');
  });
});

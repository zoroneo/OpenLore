import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCdk } from './cdk.js';

const base = join(__dirname, 'fixtures', 'cdk');
function load(rel: string, language: string) {
  return { path: `cdk/${rel}`, content: readFileSync(join(base, rel), 'utf-8'), language };
}

describe('CDK / CDKTF detection', () => {
  it('detects AWS CDK constructs and a reference edge (TypeScript)', () => {
    const graph = extractCdk([load('aws-cdk-app.ts', 'TypeScript')]);
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toEqual(['Bucket:LogsBucket', 'BucketPolicy:LogsPolicy']);
    expect(graph.resources.every(r => r.language === 'CDK')).toBe(true);
    const refs = graph.references.map(r => `${r.fromAddress} -> ${r.toAddress}`);
    expect(refs).toContain('BucketPolicy:LogsPolicy -> Bucket:LogsBucket');
  });

  it('detects CDKTF constructs and a reference edge (TypeScript)', () => {
    const graph = extractCdk([load('cdktf-main.ts', 'TypeScript')]);
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toEqual(['S3Bucket:logs', 'S3BucketPolicy:logs-policy']);
    expect(graph.resources.every(r => r.language === 'CDKTF')).toBe(true);
    const refs = graph.references.map(r => `${r.fromAddress} -> ${r.toAddress}`);
    expect(refs).toContain('S3BucketPolicy:logs-policy -> S3Bucket:logs');
  });

  it('detects AWS CDK constructs (Python)', () => {
    const graph = extractCdk([load('aws_cdk_app.py', 'Python')]);
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toEqual(['Bucket:DataBucket', 'BucketPolicy:DataPolicy']);
    const refs = graph.references.map(r => `${r.fromAddress} -> ${r.toAddress}`);
    expect(refs).toContain('BucketPolicy:DataPolicy -> Bucket:DataBucket');
  });

  it('detects AWS CDK constructs (Go, jsii.String ids)', () => {
    const graph = extractCdk([load('main.go', 'Go')]);
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toEqual(['Bucket:Logs', 'BucketPolicy:LogsPolicy']);
    const refs = graph.references.map(r => `${r.fromAddress} -> ${r.toAddress}`);
    expect(refs).toContain('BucketPolicy:LogsPolicy -> Bucket:Logs');
  });

  it('ignores files without a CDK/CDKTF import', () => {
    const graph = extractCdk([{ path: 'plain.ts', content: 'const x = new Foo(this, "y", {});', language: 'TypeScript' }]);
    expect(graph.resources).toHaveLength(0);
  });
});

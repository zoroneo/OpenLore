import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractCloudFormation } from './cloudformation.js';

const file = {
  path: 'cloudformation/template.yaml',
  content: readFileSync(join(__dirname, 'fixtures', 'cloudformation', 'template.yaml'), 'utf-8'),
};

describe('cloudformation extraction', () => {
  const graph = extractCloudFormation([file]);
  const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);
  const addrs = graph.resources.map(r => r.address);

  it('parses short-form intrinsics without crashing and creates nodes', () => {
    expect(addrs).toContain('LogsBucket');
    expect(addrs).toContain('BucketPolicy');
    expect(addrs).toContain('NestedStack');
    expect(addrs).toContain('BucketName');
    expect(addrs).toContain('Output.BucketArn');
  });

  it('resolves Ref / GetAtt / Sub / DependsOn edges', () => {
    expect(refs).toContain('LogsBucket -references-> BucketName');
    expect(refs).toContain('BucketPolicy -references-> LogsBucket');
    expect(refs).toContain('BucketPolicy -depends_on-> LogsBucket');
    expect(refs).toContain('Output.BucketArn -references-> LogsBucket');
  });

  it('models cross-stack ImportValue and nested stacks as external', () => {
    const external = graph.resources.filter(r => r.isExternal).map(r => r.address);
    expect(external.some(a => a.startsWith('ImportValue:'))).toBe(true);
    expect(external.some(a => a.startsWith('Stack:'))).toBe(true);
    expect(refs.some(r => r.includes('-references-> ImportValue:'))).toBe(true);
    expect(refs.some(r => r.includes('-references-> Stack:'))).toBe(true);
  });
});

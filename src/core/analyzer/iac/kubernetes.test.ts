import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractKubernetes } from './kubernetes.js';

const file = {
  path: 'kubernetes/app.yaml',
  content: readFileSync(join(__dirname, 'fixtures', 'kubernetes', 'app.yaml'), 'utf-8'),
};

describe('kubernetes extraction', () => {
  const graph = extractKubernetes([file]);
  const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);

  it('creates one node per document', () => {
    const addrs = graph.resources.map(r => r.address).sort();
    expect(addrs).toEqual(['ConfigMap/web-config', 'Deployment/web', 'Secret/web-secret', 'Service/web', 'ServiceAccount/web-sa']);
  });

  it('resolves selector → workload edges', () => {
    expect(refs).toContain('Service/web -references-> Deployment/web');
  });

  it('resolves configMap/secret/serviceAccount references', () => {
    expect(refs).toContain('Deployment/web -references-> ConfigMap/web-config');
    expect(refs).toContain('Deployment/web -references-> Secret/web-secret');
    expect(refs).toContain('Deployment/web -references-> ServiceAccount/web-sa');
  });
});

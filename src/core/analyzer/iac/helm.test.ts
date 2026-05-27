import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractHelm } from './helm.js';

const base = join(__dirname, 'fixtures', 'helm');
function load(rel: string) {
  return { path: `helm/${rel}`, content: readFileSync(join(base, rel), 'utf-8') };
}

describe('helm extraction', () => {
  const graph = extractHelm([
    load('mychart/Chart.yaml'),
    load('mychart/values.yaml'),
    load('mychart/templates/_helpers.tpl'),
    load('mychart/templates/deployment.yaml'),
    load('mychart/charts/sub/Chart.yaml'),
  ]);
  const addrs = graph.resources.map(r => r.address);
  const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);

  it('creates a chart node and named-template nodes', () => {
    expect(addrs).toContain('chart.mychart');
    expect(addrs).toContain('mychart:define:mychart.fullname');
    expect(addrs).toContain('mychart:define:mychart.labels');
  });

  it('links chart → subchart dependencies (external when remote)', () => {
    expect(refs).toContain('chart.mychart -depends_on-> chart.sub');
    expect(refs).toContain('chart.mychart -depends_on-> chart.redis');
    expect(graph.resources.find(r => r.address === 'chart.redis')?.isExternal).toBe(true);
    expect(graph.resources.find(r => r.address === 'chart.sub')?.isExternal).toBeUndefined();
  });

  it('links template → named-template (include) references', () => {
    expect(refs).toContain('mychart:tpl:templates/deployment.yaml -references-> mychart:define:mychart.fullname');
    expect(refs).toContain('mychart:tpl:templates/deployment.yaml -references-> mychart:define:mychart.labels');
  });

  it('does not crash on templated values and extracts the rendered shape', () => {
    expect(addrs.some(a => a.startsWith('mychart:Deployment/'))).toBe(true);
  });

  it('resolves .Values.x references to values.yaml keys', () => {
    expect(addrs).toContain('mychart:values:replicaCount');
    expect(addrs).toContain('mychart:values:image.repository');
    expect(addrs).toContain('mychart:values:image.tag');
    expect(refs).toContain('mychart:tpl:templates/deployment.yaml -references-> mychart:values:replicaCount');
    expect(refs).toContain('mychart:tpl:templates/deployment.yaml -references-> mychart:values:image.repository');
  });
});

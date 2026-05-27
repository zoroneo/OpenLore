import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractAnsible } from './ansible.js';

const base = join(__dirname, 'fixtures', 'ansible');
function load(rel: string) {
  return { path: `ansible/${rel}`, content: readFileSync(join(base, rel), 'utf-8') };
}

describe('ansible extraction', () => {
  const graph = extractAnsible([
    load('site.yml'),
    load('roles/web/tasks/main.yml'),
    load('roles/web/handlers/main.yml'),
    load('roles/db/meta/main.yml'),
    load('tasks/extra.yml'),
    load('loop-include.yml'),
    load('tasks/a.yml'),
    load('tasks/b.yml'),
  ]);
  const addrs = graph.resources.map(r => r.address);
  const refs = graph.references.map(r => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);

  it('creates play, role, task, and handler nodes', () => {
    expect(addrs.some(a => a.startsWith('play:'))).toBe(true);
    expect(addrs).toContain('role.web');
    expect(addrs).toContain('role.db');
    expect(addrs).toContain('task:web:Deploy web config');
  });

  it('links play → role', () => {
    expect(refs.some(r => r.startsWith('play:') && r.endsWith('-references-> role.web'))).toBe(true);
    expect(refs.some(r => r.endsWith('-references-> role.db'))).toBe(true);
  });

  it('links task → handler via notify', () => {
    expect(refs).toContain('task:web:Deploy web config -references-> handler:web:reload web');
  });

  it('links include_tasks → included tasks file', () => {
    expect(refs.some(r => r.includes('-references-> tasks:ansible/tasks/extra.yml'))).toBe(true);
  });

  it('links role → role via meta dependencies', () => {
    expect(refs).toContain('role.db -depends_on-> role.web');
  });

  it('resolves a templated include backed by a static loop list', () => {
    expect(refs.some(r => r.includes('-references-> tasks:ansible/tasks/a.yml'))).toBe(true);
    expect(refs.some(r => r.includes('-references-> tasks:ansible/tasks/b.yml'))).toBe(true);
  });
});

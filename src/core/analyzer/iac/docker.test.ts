import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractDocker, isDockerfilePath } from './docker.js';

const df = (content: string, path = 'Dockerfile') => ({ path, content, language: 'Dockerfile' });
const compose = (content: string, path = 'docker-compose.yml') => ({ path, content, language: 'Docker Compose' });

const refsOf = (g: ReturnType<typeof extractDocker>) =>
  g.references.map((r) => `${r.fromAddress} -${r.kind}-> ${r.toAddress}`);

describe('isDockerfilePath', () => {
  it('recognizes the conventional Dockerfile names', () => {
    expect(isDockerfilePath('Dockerfile')).toBe(true);
    expect(isDockerfilePath('api/Dockerfile')).toBe(true);
    expect(isDockerfilePath('Dockerfile.prod')).toBe(true);
    expect(isDockerfilePath('build/api.Dockerfile')).toBe(true);
    expect(isDockerfilePath('Containerfile')).toBe(true);
    expect(isDockerfilePath('docker-compose.yml')).toBe(false);
    expect(isDockerfilePath('src/index.ts')).toBe(false);
  });
});

describe('Dockerfile extraction', () => {
  const g = extractDocker([
    df(
      [
        'FROM python:3.12-slim AS builder',
        'RUN pip install -r requirements.txt',
        'FROM builder AS test',
        'RUN pytest',
        'FROM python:3.12-slim',
        'COPY --from=builder /app /app',
      ].join('\n'),
    ),
  ]);
  const addrs = g.resources.map((r) => r.address);
  const refs = refsOf(g);

  it('creates one node per build stage', () => {
    expect(addrs).toContain('Dockerfile::builder');
    expect(addrs).toContain('Dockerfile::test');
    expect(addrs).toContain('Dockerfile::stage2');
  });

  it('models external base images as deduped external nodes', () => {
    const external = g.resources.filter((r) => r.isExternal).map((r) => r.address);
    expect(external).toContain('python:3.12-slim');
    // python:3.12-slim is referenced by two stages but is a single node.
    expect(external.filter((a) => a === 'python:3.12-slim')).toHaveLength(1);
  });

  it('resolves FROM-stage, FROM-image, and COPY --from edges', () => {
    expect(refs).toContain('Dockerfile::builder -references-> python:3.12-slim');
    expect(refs).toContain('Dockerfile::test -references-> Dockerfile::builder');
    expect(refs).toContain('Dockerfile::stage2 -references-> python:3.12-slim');
    expect(refs).toContain('Dockerfile::stage2 -references-> Dockerfile::builder');
  });
});

describe('Dockerfile dynamic + scratch bases', () => {
  it('emits no edge for an ARG-templated FROM, and no node for scratch', () => {
    const g = extractDocker([
      df(['ARG BASE_IMAGE=alpine', 'FROM ${BASE_IMAGE} AS app', 'FROM scratch AS empty'].join('\n')),
    ]);
    expect(g.resources.map((r) => r.address)).toEqual(
      expect.arrayContaining(['Dockerfile::app', 'Dockerfile::empty']),
    );
    // No external image node and no dependency edge for either.
    expect(g.resources.filter((r) => r.isExternal)).toHaveLength(0);
    expect(g.references).toHaveLength(0);
  });
});

describe('docker-compose extraction', () => {
  const g = extractDocker([
    compose(
      [
        'services:',
        '  api:',
        '    image: postgres:16',
        '    depends_on:',
        '      - db',
        '  db:',
        '    image: postgres:16',
        '  web:',
        '    depends_on:',
        '      api:',
        '        condition: service_started',
        '    links:',
        '      - db:database',
      ].join('\n'),
    ),
  ]);
  const refs = refsOf(g);

  it('creates one node per service', () => {
    const addrs = g.resources.filter((r) => !r.isExternal).map((r) => r.address);
    expect(addrs).toEqual(
      expect.arrayContaining([
        'docker-compose.yml::service.api',
        'docker-compose.yml::service.db',
        'docker-compose.yml::service.web',
      ]),
    );
  });

  it('resolves depends_on (list + map) and links', () => {
    expect(refs).toContain('docker-compose.yml::service.api -depends_on-> docker-compose.yml::service.db');
    expect(refs).toContain('docker-compose.yml::service.web -depends_on-> docker-compose.yml::service.api');
    expect(refs).toContain('docker-compose.yml::service.web -references-> docker-compose.yml::service.db');
  });

  it('models image-only services as external image edges, deduped', () => {
    expect(refs).toContain('docker-compose.yml::service.api -references-> postgres:16');
    expect(refs).toContain('docker-compose.yml::service.db -references-> postgres:16');
    expect(g.resources.filter((r) => r.address === 'postgres:16')).toHaveLength(1);
  });
});

describe('compose ↔ Dockerfile cross-file resolution (fixtures)', () => {
  const dir = join(__dirname, 'fixtures', 'docker');
  const g = extractDocker([
    df(readFileSync(join(dir, 'api', 'Dockerfile'), 'utf-8'), 'api/Dockerfile'),
    compose(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'), 'docker-compose.yml'),
  ]);
  const refs = refsOf(g);

  it('resolves a service build: to the Dockerfile final stage', () => {
    // api builds ./api with no target → final stage of api/Dockerfile (anonymous stage2).
    expect(refs).toContain('docker-compose.yml::service.api -references-> api/Dockerfile::stage2');
  });

  it('resolves a service build.target to the named stage', () => {
    expect(refs).toContain('docker-compose.yml::service.web -references-> api/Dockerfile::builder');
  });

  it('prefers build over image (image is the build tag, not a dependency)', () => {
    // api declares both build and image: myorg/api:latest — no external edge for the tag.
    expect(refs.some((r) => r.includes('myorg/api:latest'))).toBe(false);
  });

  it('chains service → stage → base image for end-to-end reachability', () => {
    expect(refs).toContain('api/Dockerfile::stage2 -references-> python:3.12-slim');
  });

  it('is deterministic across runs', () => {
    const a = extractDocker([
      df(readFileSync(join(dir, 'api', 'Dockerfile'), 'utf-8'), 'api/Dockerfile'),
      compose(readFileSync(join(dir, 'docker-compose.yml'), 'utf-8'), 'docker-compose.yml'),
    ]);
    expect(refsOf(a).sort()).toEqual(refs.sort());
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractDocker, isDockerfilePath } from './docker.js';
import { projectIacGraph } from './project.js';

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
  it('emits no edge for a defaultless-ARG-templated FROM, and no node for scratch', () => {
    // ARG with NO default → ${BASE_IMAGE} is genuinely dynamic (resolved at build time).
    const g = extractDocker([
      df(['ARG BASE_IMAGE', 'FROM ${BASE_IMAGE} AS app', 'FROM scratch AS empty'].join('\n')),
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

// Regression coverage for real-world Dockerfile/compose syntax that adversarial
// e2e dogfooding (PR #193 review) found breaking the naive parser.
describe('Dockerfile robustness (adversarial regressions)', () => {
  it('ignores FROM/COPY --from inside heredoc bodies', () => {
    const g = extractDocker([
      df(['FROM node:20 AS base', 'RUN <<EOF', 'FROM not-a-stage', 'COPY --from=99 /a /b', 'echo hi', 'EOF'].join('\n')),
    ]);
    expect(g.resources.filter((r) => !r.isExternal).map((r) => r.address)).toEqual(['Dockerfile::base']);
    expect(g.resources.some((r) => r.address === 'not-a-stage')).toBe(false);
    expect(refsOf(g)).toEqual(['Dockerfile::base -references-> node:20']);
  });

  it('joins line continuations across a FROM instruction', () => {
    const g = extractDocker([df(['FROM \\', '  python:3.12 AS app', 'COPY --from=app /a /b'].join('\n'))]);
    expect(g.resources.some((r) => r.address === 'Dockerfile::app')).toBe(true);
    expect(g.resources.some((r) => r.address === '\\')).toBe(false);
    expect(refsOf(g)).toContain('Dockerfile::app -references-> python:3.12');
  });

  it('tolerates trailing inline comments on FROM lines (single-stage)', () => {
    const g = extractDocker([df('FROM python:3.12-slim   # base, pinned\nWORKDIR /app')]);
    expect(g.resources.some((r) => r.address === 'Dockerfile::stage0')).toBe(true);
    expect(refsOf(g)).toEqual(['Dockerfile::stage0 -references-> python:3.12-slim']);
  });

  it('tolerates trailing inline comments on multi-stage FROM ... AS lines', () => {
    const g = extractDocker([df('FROM node:20-alpine AS base  # pin\nFROM base AS final  # final\nCOPY . .')]);
    expect(g.resources.filter((r) => !r.isExternal).map((r) => r.address)).toEqual(
      expect.arrayContaining(['Dockerfile::base', 'Dockerfile::final']),
    );
    expect(g.resources.some((r) => r.address === 'base' && r.isExternal)).toBe(false);
    expect(refsOf(g)).toContain('Dockerfile::final -references-> Dockerfile::base');
    expect(refsOf(g)).toContain('Dockerfile::base -references-> node:20-alpine');
  });

  it('ignores whole-line comments mentioning FROM', () => {
    const g = extractDocker([df('# FROM commented:nope\nFROM alpine:3.20\n')]);
    expect(g.resources.some((r) => r.address === 'commented:nope')).toBe(false);
    expect(refsOf(g)).toEqual(['Dockerfile::stage0 -references-> alpine:3.20']);
  });

  it('handles CRLF line endings', () => {
    const g = extractDocker([df('FROM node:20 AS base\r\nFROM base AS final\r\nCOPY --from=base /a /b\r\n')]);
    expect(refsOf(g)).toContain('Dockerfile::base -references-> node:20');
    expect(refsOf(g)).toContain('Dockerfile::final -references-> Dockerfile::base');
  });
});

describe('docker-compose robustness (adversarial regressions)', () => {
  it('expands YAML merge keys (x-*: &anchor / <<: *anchor)', () => {
    const g = extractDocker([
      compose(
        [
          'x-common: &common',
          '  image: apache/airflow:2.9.0',
          '  depends_on:',
          '    - db',
          'services:',
          '  web:',
          '    <<: *common',
          '  db:',
          '    image: postgres:16',
        ].join('\n'),
      ),
    ]);
    const refs = refsOf(g);
    expect(refs).toContain('docker-compose.yml::service.web -references-> apache/airflow:2.9.0');
    expect(refs).toContain('docker-compose.yml::service.web -depends_on-> docker-compose.yml::service.db');
    // No literal `<<` ever becomes a service candidate.
    expect(g.resources.some((r) => r.address.endsWith('service.<<'))).toBe(false);
  });

  it('does not mint a garbage node from recoverable-but-malformed YAML', () => {
    const g = extractDocker([compose('services:\n  web:\n    image: [ { bad: [ unclosed ]\n')]);
    expect(g.resources).toHaveLength(0);
  });
});

describe('Dockerfile stage-name case-insensitivity (Docker/BuildKit semantics)', () => {
  it('resolves COPY --from and FROM to a differently-cased stage name', () => {
    const g = extractDocker([
      df(['FROM node:20 AS Builder', 'FROM Builder AS final', 'COPY --from=builder /a /b'].join('\n')),
    ]);
    // No bogus external image named after the stage.
    expect(g.resources.some((r) => r.isExternal && r.address === 'builder')).toBe(false);
    expect(g.resources.filter((r) => r.isExternal).map((r) => r.address)).toEqual(['node:20']);
    expect(refsOf(g)).toContain('Dockerfile::final -references-> Dockerfile::Builder');
    // FROM Builder + COPY --from=builder dedupe to a single projected edge.
    const projected = projectIacGraph(g);
    const finalId = projected.nodes.find((n) => n.name === 'Dockerfile::final')!.id;
    const builderId = projected.nodes.find((n) => n.name === 'Dockerfile::Builder')!.id;
    expect(projected.edges.filter((e) => e.callerId === finalId && e.calleeId === builderId)).toHaveLength(1);
  });

  it('resolves a compose build.target case-insensitively', () => {
    const g = extractDocker([
      df('FROM x AS Builder\nFROM scratch', 'api/Dockerfile'),
      compose('services:\n  web:\n    build:\n      context: ./api\n      target: BUILDER\n'),
    ]);
    expect(refsOf(g)).toContain('docker-compose.yml::service.web -references-> api/Dockerfile::Builder');
  });
});

describe('variable interpolation with inline defaults (compose + Dockerfile)', () => {
  it('resolves compose image: ${VAR:-default} (the Airflow pattern)', () => {
    const g = extractDocker([
      compose('services:\n  web:\n    image: ${AIRFLOW_IMAGE_NAME:-apache/airflow:3.0.0}\n  db:\n    image: ${DB-postgres:16}\n'),
    ]);
    const refs = refsOf(g);
    expect(refs).toContain('docker-compose.yml::service.web -references-> apache/airflow:3.0.0');
    expect(refs).toContain('docker-compose.yml::service.db -references-> postgres:16');
  });

  it('resolves every ${VAR:-default} segment in a registry/name:tag ref', () => {
    const g = extractDocker([compose('services:\n  app:\n    image: ${REG:-docker.io}/${NS:-lib}/app:${TAG:-1.2}\n')]);
    expect(refsOf(g)).toContain('docker-compose.yml::service.app -references-> docker.io/lib/app:1.2');
  });

  it('emits no edge when interpolation has no inline default', () => {
    const g = extractDocker([compose('services:\n  a:\n    image: ${ONLYVAR}\n  b:\n    image: ${NEEDED:?must set}\n')]);
    expect(g.references).toHaveLength(0);
    expect(g.resources.some((r) => r.isExternal)).toBe(false);
  });

  it('resolves a Dockerfile FROM ${BASE:-default} inline default', () => {
    const g = extractDocker([df('FROM ${BASE:-node:20} AS app')]);
    expect(refsOf(g)).toContain('Dockerfile::app -references-> node:20');
  });

  it('resolves an interpolated compose build.dockerfile default', () => {
    const g = extractDocker([
      df('FROM alpine AS app', 'api/Dockerfile'),
      compose('services:\n  web:\n    build:\n      context: ./api\n      dockerfile: ${DF:-Dockerfile}\n'),
    ]);
    expect(refsOf(g)).toContain('docker-compose.yml::service.web -references-> api/Dockerfile::app');
  });
});

describe('Dockerfile ARG-default base-image resolution (Docker build-arg semantics)', () => {
  it('resolves FROM node:${NODE_VERSION} using a global ARG default', () => {
    const g = extractDocker([df('ARG NODE_VERSION=20\nFROM node:${NODE_VERSION}-alpine AS app\nRUN echo hi')]);
    expect(refsOf(g)).toEqual(['Dockerfile::app -references-> node:20-alpine']);
  });

  it('resolves the bare $VAR form too', () => {
    const g = extractDocker([df('ARG GO=1.22\nFROM golang:$GO AS build')]);
    expect(refsOf(g)).toContain('Dockerfile::build -references-> golang:1.22');
  });

  it('applies a global ARG to every FROM that uses it', () => {
    const g = extractDocker([df('ARG TAG=3.20\nFROM alpine:${TAG} AS a\nFROM alpine:${TAG} AS b')]);
    expect(refsOf(g)).toContain('Dockerfile::a -references-> alpine:3.20');
    expect(refsOf(g)).toContain('Dockerfile::b -references-> alpine:3.20');
  });

  it('emits no edge for an ARG with no default', () => {
    const g = extractDocker([df('ARG BASE\nFROM ${BASE} AS app')]);
    expect(g.references).toHaveLength(0);
    expect(g.resources.some((r) => r.isExternal)).toBe(false);
  });

  it('does NOT apply a stage-scoped ARG (declared after the first FROM) to a later FROM', () => {
    // Docker: only ARGs before the first FROM are global; T2 here is stage-scoped.
    const g = extractDocker([df('ARG T=1\nFROM alpine:${T} AS a\nARG T2=2\nFROM alpine:${T2} AS b')]);
    expect(refsOf(g)).toContain('Dockerfile::a -references-> alpine:1');
    expect(g.references.some((r) => r.toAddress.includes('alpine:2'))).toBe(false);
    expect(g.references.some((r) => r.fromAddress === 'Dockerfile::b')).toBe(false);
  });
});

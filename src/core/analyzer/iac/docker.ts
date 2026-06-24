/**
 * Docker container extraction (spec-07 deferred follow-up: add-docker-container-graph).
 *
 * Parses Dockerfiles and docker-compose files together — they are cross-referential
 * (a compose `build:` resolves to a Dockerfile stage), so one extractor sees both —
 * and produces the normalized IacGraph that project.ts maps onto FunctionNode/CallEdge.
 *
 * Edge direction is dependent → dependency (like the rest of IaC), so depth-1 callers
 * of a base image answer "every stage/service rebuilt if this image moves".
 *
 * Static only: no `docker build`, no compose interpolation, no registry access.
 * Dynamic references (FROM ${ARG}, fully-templated build context) emit no edge.
 */

import { parseDocument } from 'yaml';
import type { IacGraph, IacReference } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language: string }

/**
 * True when a path names a Dockerfile: `Dockerfile`, `Dockerfile.<suffix>`,
 * `<name>.Dockerfile`, or `Containerfile` (Podman's equivalent). Compose files are
 * `.yaml`/`.yml` and are classified by `classifyYaml`, not here.
 */
export function isDockerfilePath(path: string): boolean {
  const base = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  return (
    base === 'dockerfile' ||
    base === 'containerfile' ||
    base.startsWith('dockerfile.') ||
    base.endsWith('.dockerfile')
  );
}

const posixDir = (p: string): string => {
  const posix = p.replace(/\\/g, '/');
  const i = posix.lastIndexOf('/');
  return i === -1 ? '' : posix.slice(0, i);
};

/** Normalize a POSIX path, resolving `.` and `..` segments. */
function posixNormalize(p: string): string {
  const segs = p.replace(/\\/g, '/').split('/');
  const out: string[] = [];
  for (const s of segs) {
    if (s === '' || s === '.') continue;
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(s);
  }
  return out.join('/');
}

/** A parsed Dockerfile stage and the address compose resolves a build to. */
interface DockerfileInfo {
  /** stage name → stage address, for COPY --from / FROM-stage resolution. */
  stageAddrByName: Map<string, string>;
  /** stage addresses in build order, for numeric COPY --from=<index>. */
  stageAddrByIndex: string[];
  /** The default build target: address of the last stage. */
  finalStageAddress: string;
}

const EXTERNAL_IMAGE_LANG = 'Dockerfile'; // one canonical tag so images dedupe across files

export function extractDocker(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  const dockerfiles = files.filter((f) => f.language === 'Dockerfile');
  const composeFiles = files.filter((f) => f.language === 'Docker Compose');

  // External image nodes are deduped by reference across the whole set.
  const externalImages = new Set<string>();
  const ensureImage = (ref: string) => {
    if (externalImages.has(ref)) return;
    externalImages.add(ref);
    graph.resources.push({
      address: ref,
      type: 'image',
      kind: 'resource',
      filePath: '',
      startLine: 1,
      isExternal: true,
      signature: `image ${ref}`,
      language: EXTERNAL_IMAGE_LANG,
    });
  };

  // Parse Dockerfiles first so compose `build:` can resolve to a real stage address.
  const dockerInfoByPath = new Map<string, DockerfileInfo>();
  for (const f of dockerfiles) {
    dockerInfoByPath.set(posixNormalize(f.path), parseDockerfile(f.path, f.content, graph, ensureImage));
  }

  for (const f of composeFiles) {
    parseCompose(f.path, f.content, graph, ensureImage, dockerInfoByPath);
  }

  return graph;
}

// ── Dockerfile ───────────────────────────────────────────────────────────────

const FROM_RE = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?\s*$/i;
const COPY_FROM_RE = /^\s*(?:COPY|ADD)\s+(?:[^\n]*?\s)?--from=(\S+)/i;
const ARG_REF_RE = /\$\{?[A-Za-z_]/; // FROM ${BASE} / $BASE — dynamic, not resolvable

function parseDockerfile(
  filePath: string,
  content: string,
  graph: IacGraph,
  ensureImage: (ref: string) => void,
): DockerfileInfo {
  const stageAddrByName = new Map<string, string>();
  const stageAddrByIndex: string[] = [];
  // pending COPY --from sources per stage index, resolved after all stages are known.
  const copyFromByStage: Array<Array<{ ref: string; line: number }>> = [];
  const fromByStage: Array<{ base: string; line: number } | null> = [];

  const lines = content.split('\n');
  let stageIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const fromM = FROM_RE.exec(raw);
    if (fromM) {
      stageIndex++;
      const base = fromM[1];
      const asName = fromM[2];
      const stageName = asName ?? `stage${stageIndex}`;
      const address = `${filePath}::${stageName}`;
      graph.resources.push({
        address,
        type: 'docker-stage',
        kind: 'resource',
        filePath,
        startLine: i + 1,
        signature: asName ? `FROM ${base} AS ${asName}` : `FROM ${base}`,
        language: 'Dockerfile',
      });
      stageAddrByName.set(stageName, address);
      stageAddrByIndex.push(address);
      fromByStage.push({ base, line: i + 1 });
      copyFromByStage.push([]);
      continue;
    }
    const copyM = COPY_FROM_RE.exec(raw);
    if (copyM && stageIndex >= 0) {
      copyFromByStage[stageIndex].push({ ref: copyM[1], line: i + 1 });
    }
  }

  if (stageIndex < 0) {
    return { stageAddrByName, stageAddrByIndex, finalStageAddress: '' };
  }

  // Resolve FROM bases and COPY --from sources now that every stage name is known.
  const addRef = (from: string, to: string, line: number, kind: IacReference['kind']) => {
    if (from === to) return;
    graph.references.push({ fromAddress: from, toAddress: to, kind, line });
  };

  for (let s = 0; s <= stageIndex; s++) {
    const stageAddr = stageAddrByIndex[s];
    const from = fromByStage[s];
    if (from && !ARG_REF_RE.test(from.base)) {
      const earlier = stageAddrByName.get(from.base);
      if (earlier) {
        addRef(stageAddr, earlier, from.line, 'references');
      } else if (from.base.toLowerCase() !== 'scratch') {
        ensureImage(from.base);
        addRef(stageAddr, from.base, from.line, 'references');
      }
      // else: `FROM scratch` — the empty base, no dependency.
    }
    for (const cf of copyFromByStage[s]) {
      if (ARG_REF_RE.test(cf.ref)) continue; // dynamic --from, no edge
      const named = stageAddrByName.get(cf.ref);
      if (named) { addRef(stageAddr, named, cf.line, 'references'); continue; }
      const asIndex = Number(cf.ref);
      if (Number.isInteger(asIndex) && asIndex >= 0 && asIndex < stageAddrByIndex.length) {
        addRef(stageAddr, stageAddrByIndex[asIndex], cf.line, 'references');
        continue;
      }
      // Otherwise --from references an external image (e.g. COPY --from=nginx:latest …).
      ensureImage(cf.ref);
      addRef(stageAddr, cf.ref, cf.line, 'references');
    }
  }

  return {
    stageAddrByName,
    stageAddrByIndex,
    finalStageAddress: stageAddrByIndex[stageAddrByIndex.length - 1],
  };
}

// ── docker-compose ─────────────────────────────────────────────────────────────

function parseCompose(
  filePath: string,
  content: string,
  graph: IacGraph,
  ensureImage: (ref: string) => void,
  dockerInfoByPath: Map<string, DockerfileInfo>,
): void {
  let doc;
  try {
    doc = parseDocument(content);
  } catch {
    return;
  }
  const js = doc.toJS() as Record<string, unknown> | null;
  if (!js || typeof js !== 'object') return;
  const services = js.services;
  if (!services || typeof services !== 'object') return;

  const addrOf = (name: string) => `${filePath}::service.${name}`;
  const declared = new Set<string>();
  const composeDir = posixDir(filePath);

  // Pass 1: declare every service node (so same-file references resolve regardless of order).
  const lineOf = (name: string): number => {
    const node = doc.getIn(['services', name], true) as { range?: [number, number, number] } | undefined;
    const off = node?.range?.[0];
    // yaml's LineCounter is overkill here; approximate via the raw text once.
    return off != null ? offsetToLine(content, off) : 1;
  };
  for (const name of Object.keys(services as Record<string, unknown>)) {
    declared.add(name);
    graph.resources.push({
      address: addrOf(name),
      type: 'compose-service',
      kind: 'resource',
      filePath,
      startLine: lineOf(name),
      signature: `service ${name}`,
      language: 'Docker Compose',
    });
  }

  // Pass 2: edges.
  const addRef = (from: string, to: string, kind: IacReference['kind']) => {
    if (from === to) return;
    graph.references.push({ fromAddress: from, toAddress: to, kind });
  };
  for (const [name, body] of Object.entries(services as Record<string, unknown>)) {
    if (!body || typeof body !== 'object') continue;
    const svc = body as Record<string, unknown>;
    const from = addrOf(name);

    // depends_on: list ["db"] or map { db: {condition} }.
    for (const dep of namesOf(svc.depends_on)) {
      if (declared.has(dep)) addRef(from, addrOf(dep), 'depends_on');
    }
    // links: ["db", "db:alias"] — the part before ':' is the service name.
    for (const link of toArray(svc.links)) {
      if (typeof link !== 'string') continue;
      const target = link.split(':')[0].trim();
      if (declared.has(target)) addRef(from, addrOf(target), 'references');
    }

    // build → resolved Dockerfile stage. Wins over `image:` (image is the build's tag name).
    const buildTarget = resolveBuildTarget(svc.build, composeDir, dockerInfoByPath);
    if (buildTarget) {
      addRef(from, buildTarget, 'references');
    } else if (typeof svc.image === 'string' && svc.image && !ARG_REF_RE.test(svc.image)) {
      ensureImage(svc.image);
      addRef(from, svc.image, 'references');
    }
  }
}

/** Resolve a service `build:` to a Dockerfile stage address, or null if unresolvable. */
function resolveBuildTarget(
  build: unknown,
  composeDir: string,
  dockerInfoByPath: Map<string, DockerfileInfo>,
): string | null {
  if (build == null) return null;
  let context: string;
  let dockerfile = 'Dockerfile';
  let target: string | undefined;
  if (typeof build === 'string') {
    context = build;
  } else if (typeof build === 'object') {
    const b = build as Record<string, unknown>;
    if (typeof b.context !== 'string') return null;
    context = b.context;
    if (typeof b.dockerfile === 'string') dockerfile = b.dockerfile;
    if (typeof b.target === 'string') target = b.target;
  } else {
    return null;
  }
  if (ARG_REF_RE.test(context) || ARG_REF_RE.test(dockerfile)) return null; // templated → no edge
  const dfPath = posixNormalize([composeDir, context, dockerfile].filter(Boolean).join('/'));
  const info = dockerInfoByPath.get(dfPath);
  if (!info) return null; // Dockerfile not in the indexed set → best-effort, no edge
  if (target) return info.stageAddrByName.get(target) ?? null;
  return info.finalStageAddress || null;
}

/** Service names from a compose `depends_on` (array or map form). */
function namesOf(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (v && typeof v === 'object') return Object.keys(v as Record<string, unknown>);
  return [];
}

function toArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function offsetToLine(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content[i] === '\n') line++;
  }
  return line;
}

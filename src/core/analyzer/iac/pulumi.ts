/**
 * Pulumi framework detector (spec-07, lightest ecosystem).
 *
 * Pulumi programs are written in TS/JS/Python/Go — already parsed for the call
 * graph. We do NOT add a grammar; we recognize Pulumi resource constructions
 * over the existing source and emit extra `Pulumi` resource nodes + reference
 * edges, without touching the normal call graph for those files.
 *
 * Scope conservatively: only the common provider SDKs (@pulumi/aws, /gcp,
 * /azure-native, /kubernetes). Unknown SDKs → no resource nodes.
 * CDK / CDKTF are intentionally out of scope (deferred to a future spec).
 */

import type { IacGraph, IacResource } from './types.js';
import { emptyIacGraph } from './types.js';

interface InFile { path: string; content: string; language: string }

const PROVIDER_PKGS = ['@pulumi/aws', '@pulumi/gcp', '@pulumi/azure', '@pulumi/azure-native', '@pulumi/kubernetes', '@pulumi/pulumi'];
const PY_PROVIDER_MODS = ['pulumi_aws', 'pulumi_gcp', 'pulumi_azure', 'pulumi_azure_native', 'pulumi_kubernetes', 'pulumi'];
const GO_PROVIDER_PATHS = ['pulumi-aws', 'pulumi-gcp', 'pulumi-azure', 'pulumi-azure-native', 'pulumi-kubernetes', 'pulumi/pulumi/sdk'];

interface Construction {
  address: string;
  service: string;
  name: string;
  line: number;
  varName?: string;
  argsText: string;
}

export function extractPulumi(files: InFile[]): IacGraph {
  const graph = emptyIacGraph();
  for (const file of files) {
    if (file.language === 'TypeScript' || file.language === 'JavaScript') {
      ingest(file, detectTsProviderNames(file.content), true, graph);
    } else if (file.language === 'Python') {
      ingest(file, detectPyProviderNames(file.content), false, graph);
    } else if (file.language === 'Go') {
      ingestGo(file, detectGoProviderNames(file.content), graph);
    }
  }
  return graph;
}

/** Go: `bucket, _ := s3.NewBucket(ctx, "logs", &s3.BucketArgs{…})`. */
function ingestGo(file: InFile, providerNames: Set<string>, graph: IacGraph): void {
  if (providerNames.size === 0) return;
  const re = /(?:(\w+)\s*(?:,\s*\w+\s*)?:?=\s*)?([A-Za-z_]\w*)\.New([A-Z]\w*)\(\s*[\w.]+\s*,\s*"([^"]+)"/g;
  const constructions: Construction[] = [];
  for (const m of file.content.matchAll(re)) {
    const [, varName, pkg, service, name] = m;
    if (!providerNames.has(pkg)) continue;
    const callParen = (m.index ?? 0) + m[0].indexOf('(');
    constructions.push({
      address: `${service}:${name}`, service, name,
      line: lineOf(file.content, m.index ?? 0), varName, argsText: sliceArgs(file.content, callParen),
    });
  }
  emitConstructions(constructions, file, graph);
}

/** Go provider package local names (alias or last import-path segment). */
function detectGoProviderNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const m of content.matchAll(/(?:(\w+)\s+)?"(github\.com\/pulumi\/[^"]+)"/g)) {
    const alias = m[1];
    const path = m[2];
    if (!GO_PROVIDER_PATHS.some((p) => path.includes(p))) continue;
    names.add(alias ?? path.split('/').pop()!);
  }
  return names;
}

function ingest(file: InFile, providerNames: Set<string>, isTs: boolean, graph: IacGraph): void {
  if (providerNames.size === 0) return;
  emitConstructions(findConstructions(file.content, providerNames, isTs), file, graph);
}

/** Emit resource nodes + variable-reference edges for detected constructions. */
function emitConstructions(constructions: Construction[], file: InFile, graph: IacGraph): void {
  const byVar = new Map<string, string>();
  for (const c of constructions) {
    if (c.varName) byVar.set(c.varName, c.address);
  }
  for (const c of constructions) {
    const r: IacResource = {
      address: c.address, type: c.service, kind: 'resource', filePath: file.path,
      startLine: c.line, signature: `new ${c.service}("${c.name}")`, language: 'Pulumi',
    };
    graph.resources.push(r);
  }
  // Reference edges: a construction's args mention another resource's variable.
  for (const c of constructions) {
    const seen = new Set<string>();
    for (const tok of c.argsText.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const target = byVar.get(tok[1]);
      if (target && target !== c.address && !seen.has(target)) {
        seen.add(target);
        graph.references.push({ fromAddress: c.address, toAddress: target, kind: 'references', line: c.line });
      }
    }
  }
}

function findConstructions(content: string, providerNames: Set<string>, isTs: boolean): Construction[] {
  const out: Construction[] = [];
  // TS: `new aws.s3.Bucket("logs", {...})`; Py: `aws.s3.Bucket("logs", ...)`.
  const re = isTs
    ? /(?:(?:const|let|var)\s+(\w+)\s*=\s*)?new\s+([A-Za-z_]\w*(?:\.\w+)*)\s*\(\s*["']([^"']+)["']/g
    : /(?:(\w+)\s*=\s*)?([A-Za-z_]\w*(?:\.\w+)*)\s*\(\s*["']([^"']+)["']/g;
  for (const m of content.matchAll(re)) {
    const varName = m[1];
    const dotted = m[2];
    const name = m[3];
    const segs = dotted.split('.');
    const root = segs[0];
    const service = segs[segs.length - 1];
    if (!providerNames.has(root)) continue;
    // Service must be a class-like capitalized identifier.
    if (!/^[A-Z]/.test(service)) continue;
    const callParen = (m.index ?? 0) + m[0].lastIndexOf('(');
    out.push({
      address: `${service}:${name}`,
      service,
      name,
      line: lineOf(content, m.index ?? 0),
      varName,
      argsText: sliceArgs(content, callParen),
    });
  }
  return out;
}

/** Local names bound to a Pulumi provider import (TS/JS). */
function detectTsProviderNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const pkg of PROVIDER_PKGS) {
    const esc = pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // import * as aws from "@pulumi/aws";  /  import aws from "@pulumi/aws";
    for (const m of content.matchAll(new RegExp(`import\\s+(?:\\*\\s+as\\s+)?(\\w+)\\s+from\\s+["']${esc}["']`, 'g'))) names.add(m[1]);
    // import { s3 } from "@pulumi/aws";
    for (const m of content.matchAll(new RegExp(`import\\s+\\{([^}]+)\\}\\s+from\\s+["']${esc}["']`, 'g'))) {
      for (const part of m[1].split(',')) {
        const n = (part.match(/\bas\s+(\w+)/) ?? part.match(/(\w+)/))?.[1]?.trim();
        if (n) names.add(n);
      }
    }
    // const aws = require("@pulumi/aws");
    for (const m of content.matchAll(new RegExp(`(\\w+)\\s*=\\s*require\\(\\s*["']${esc}["']`, 'g'))) names.add(m[1]);
  }
  return names;
}

/** Local names bound to a Pulumi provider import (Python). */
function detectPyProviderNames(content: string): Set<string> {
  const names = new Set<string>();
  for (const mod of PY_PROVIDER_MODS) {
    const esc = mod.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // import pulumi_aws as aws  /  import pulumi_aws
    for (const m of content.matchAll(new RegExp(`import\\s+${esc}(?:\\s+as\\s+(\\w+))?`, 'g'))) {
      names.add(m[1] ?? mod);
    }
    // from pulumi_aws import s3, ec2
    for (const m of content.matchAll(new RegExp(`from\\s+${esc}\\s+import\\s+([^\\n#]+)`, 'g'))) {
      for (const part of m[1].split(',')) {
        const n = (part.match(/\bas\s+(\w+)/) ?? part.match(/(\w+)/))?.[1]?.trim();
        if (n) names.add(n);
      }
    }
  }
  return names;
}

/** Slice the argument list starting at the opening paren (paren-matched). */
function sliceArgs(content: string, parenIndex: number): string {
  let depth = 0;
  let i = parenIndex;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return content.slice(parenIndex, i);
}

function lineOf(content: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') n++;
  return n;
}

/**
 * Infrastructure-as-Code — normalized resource graph types (spec-07).
 *
 * Every IaC ecosystem parser produces this normalized intermediate; a single
 * projector (project.ts) maps it onto the existing FunctionNode/CallEdge/ClassNode
 * graph primitives. No graph-schema or MCP-tool changes are required: IaC rides
 * on the existing graph (see record_decision: "IaC projects onto existing graph").
 *
 * Edge direction is dependent → dependency, so depth-1 callers of a node answers
 * "who depends on this?" (blast radius) and fanOut answers "what does this need?".
 */

/** Ecosystem language tags, used as FunctionNode.language. */
export type IacLanguage =
  | 'Terraform'
  | 'Kubernetes'
  | 'Helm'
  | 'CloudFormation'
  | 'Ansible'
  | 'Pulumi'
  | 'CDK'
  | 'CDKTF';

/** All IaC language tags (single source of truth for dispatch + gating). */
export const IAC_LANGUAGES: readonly IacLanguage[] = [
  'Terraform',
  'Kubernetes',
  'Helm',
  'CloudFormation',
  'Ansible',
  'Pulumi',
  'CDK',
  'CDKTF',
] as const;

export function isIacLanguage(lang: string): lang is IacLanguage {
  return (IAC_LANGUAGES as readonly string[]).includes(lang);
}

export type IacResourceKind =
  | 'resource'
  | 'data'
  | 'module'
  | 'variable'
  | 'output'
  | 'provider'
  | 'manifest'
  | 'play'
  | 'task'
  | 'role'
  | 'handler'
  | 'value'
  | 'stack';

/** A declared infrastructure object — projects to a FunctionNode. */
export interface IacResource {
  /** Canonical, ecosystem-specific address (e.g. "aws_s3_bucket.logs", "Deployment/web"). */
  address: string;
  /** Resource type / kind ("aws_s3_bucket", "Deployment", "AWS::S3::Bucket"). */
  type: string;
  kind: IacResourceKind;
  /** Repo-relative, POSIX path. */
  filePath: string;
  /** 1-based; REQUIRED (used for graph/SCIP ranges). */
  startLine: number;
  endLine?: number;
  /** Owning module/chart/role/stack, for grouping → ClassNode. */
  module?: string;
  /** Provider, registry module, remote chart, base image. */
  isExternal?: boolean;
  /** Declaration header, for search/signatures. */
  signature: string;
  language: IacLanguage;
}

/** A reference between two resources — projects to a CallEdge (dependent → dependency). */
export interface IacReference {
  /** The dependent (it references…). */
  fromAddress: string;
  /** …the dependency. */
  toAddress: string;
  kind: 'references' | 'depends_on';
  line?: number;
}

/** A module/chart/role/stack grouping — projects to a ClassNode. */
export interface IacModule {
  /** Canonical module address (e.g. "module.network", chart name, role name). */
  address: string;
  type: string;
  filePath: string;
  language: IacLanguage;
  isExternal?: boolean;
  /** Member resource addresses. */
  members: string[];
}

/** The normalized graph produced by an ecosystem parser. */
export interface IacGraph {
  resources: IacResource[];
  references: IacReference[];
  modules: IacModule[];
}

export function emptyIacGraph(): IacGraph {
  return { resources: [], references: [], modules: [] };
}

/** Merge several normalized graphs into one. */
export function mergeIacGraphs(graphs: IacGraph[]): IacGraph {
  const out = emptyIacGraph();
  for (const g of graphs) {
    out.resources.push(...g.resources);
    out.references.push(...g.references);
    out.modules.push(...g.modules);
  }
  return out;
}

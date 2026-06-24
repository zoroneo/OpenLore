/**
 * Projection: normalized IaC graph → existing FunctionNode/CallEdge/ClassNode (spec-07).
 *
 * This is the single place where infrastructure becomes ordinary graph nodes.
 * Because we reuse the existing primitives, orient/search_code/get_subgraph/
 * analyze_impact and the SCIP + federation exports all work on IaC unchanged.
 */

import type { CallEdge, ClassNode, FunctionNode } from '../call-graph.js';
import type { IacGraph } from './types.js';

export interface ProjectedIac {
  nodes: FunctionNode[];
  edges: CallEdge[];
  classes: ClassNode[];
}

/** Stable node id for a resource address. */
function nodeId(filePath: string, address: string, isExternal: boolean, language: string): string {
  return isExternal ? `iac-external::${language}::${address}` : `${filePath}::${address}`;
}

export function projectIacGraph(graph: IacGraph): ProjectedIac {
  // address → FunctionNode (first declaration wins; deterministic via sorted input).
  const byAddress = new Map<string, FunctionNode>();
  const nodes = new Map<string, FunctionNode>();

  const sortedResources = [...graph.resources].sort(
    (a, b) =>
      a.filePath.localeCompare(b.filePath) ||
      a.startLine - b.startLine ||
      a.address.localeCompare(b.address),
  );

  for (const r of sortedResources) {
    const id = nodeId(r.filePath, r.address, !!r.isExternal, r.language);
    if (!nodes.has(id)) {
      const node: FunctionNode = {
        id,
        name: r.displayName ?? r.address,
        filePath: r.filePath,
        className: r.type,
        isAsync: false,
        language: r.language,
        startIndex: 0,
        endIndex: 0,
        fanIn: 0,
        fanOut: 0,
        signature: r.signature,
        startLine: r.startLine,
        endLine: r.endLine ?? r.startLine,
        isExternal: r.isExternal || undefined,
      };
      nodes.set(id, node);
    }
    // First resource to claim an address owns it (for reference resolution).
    if (!byAddress.has(r.address)) byAddress.set(r.address, nodes.get(id)!);
  }

  // References → edges (dependent → dependency). Drop unresolved targets.
  const edgeSeen = new Set<string>();
  const edges: CallEdge[] = [];
  const sortedRefs = [...graph.references].sort(
    (a, b) =>
      a.fromAddress.localeCompare(b.fromAddress) ||
      a.toAddress.localeCompare(b.toAddress) ||
      a.kind.localeCompare(b.kind) ||
      (a.line ?? 0) - (b.line ?? 0),
  );
  for (const ref of sortedRefs) {
    const from = byAddress.get(ref.fromAddress);
    const to = byAddress.get(ref.toAddress);
    if (!from || !to || from.id === to.id) continue;
    const key = `${from.id}\0${to.id}\0${ref.kind}`;
    if (edgeSeen.has(key)) continue;
    edgeSeen.add(key);
    edges.push({
      callerId: from.id,
      calleeId: to.id,
      calleeName: to.name,
      line: ref.line,
      confidence: 'import',
      kind: ref.kind,
    });
  }

  // Modules → ClassNodes (module-style grouping).
  const classes: ClassNode[] = [];
  const sortedModules = [...graph.modules].sort((a, b) => a.address.localeCompare(b.address));
  for (const m of sortedModules) {
    const id = nodeId(m.filePath, m.address, !!m.isExternal, m.language);
    const methodIds = m.members
      .map((addr) => byAddress.get(addr)?.id)
      .filter((x): x is string => !!x)
      .sort();
    classes.push({
      id,
      name: m.displayName ?? m.address,
      filePath: m.filePath,
      language: m.language,
      parentClasses: [],
      interfaces: [],
      methodIds,
      fanIn: 0,
      fanOut: 0,
      isModule: true,
    });
  }

  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    classes: classes.sort((a, b) => a.id.localeCompare(b.id)),
  };
}

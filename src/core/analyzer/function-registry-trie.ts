import type { FunctionNode } from './call-graph.js';

/**
 * Three-way index over FunctionNodes enabling O(1) lookup by:
 *  - simple name ("process")
 *  - qualified name ("ClassName.methodName")
 *  - full ID ("filepath::ClassName.methodName")
 *
 * Replaces the flat Map<string, FunctionNode[]> used in Pass 2 of build(),
 * enabling className-aware resolution when a receiver type is known.
 */
export class FunctionRegistryTrie {
  private byName = new Map<string, FunctionNode[]>();
  private byQualified = new Map<string, FunctionNode[]>();
  private byId = new Map<string, FunctionNode>();

  insert(node: FunctionNode): void {
    this.byId.set(node.id, node);

    const byName = this.byName.get(node.name) ?? [];
    byName.push(node);
    this.byName.set(node.name, byName);

    if (node.className) {
      const key = `${node.className}.${node.name}`;
      const byQ = this.byQualified.get(key) ?? [];
      byQ.push(node);
      this.byQualified.set(key, byQ);
    }
  }

  findBySimpleName(name: string): FunctionNode[] {
    const arr = this.byName.get(name);
    if (!arr) return [];
    // Order candidates by their (unique) id so a name-collision tiebreak
    // (`candidates[0]` for a `name_only`/`import` pick) is deterministic and
    // INDEPENDENT of insertion order. A from-scratch `analyze` inserts in
    // file-iteration order; an incremental subset rebuild inserts the changed
    // file's fresh nodes first, then seed nodes in DB row order — so without a
    // stable sort the two builds could pick different duplicate-name targets and
    // diverge (fix-transitive-incremental-staleness). Sorted in place (idempotent).
    if (arr.length > 1) arr.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return arr;
  }

  findByQualifiedName(className: string, methodName: string): FunctionNode[] {
    return this.byQualified.get(`${className}.${methodName}`) ?? [];
  }

  findById(id: string): FunctionNode | undefined {
    return this.byId.get(id);
  }

  allNodes(): FunctionNode[] {
    return Array.from(this.byId.values());
  }
}

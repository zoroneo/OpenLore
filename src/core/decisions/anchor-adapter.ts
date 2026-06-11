/**
 * Disk-backed adapter for the code-anchored memory engine.
 * (change: add-code-anchored-memory-staleness)
 *
 * Bridges the pure {@link ./anchor.ts} engine to the running project: it reads
 * the call graph from the edge store and function/file source from disk to supply
 * {@link AnchorNode}s (for resolution) and a {@link GraphFreshnessView} (for
 * verdicts). All operations are deterministic static analysis — no LLM.
 *
 * File buffers are read once and cached per operation; an anchor set touches only
 * a handful of files, so this stays cheap. The freshness-view builder is exported
 * standalone ({@link makeFreshnessView}) so callers that already hold an open
 * edge store (e.g. orient) can reuse it instead of opening a second handle.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  OPENLORE_DIR,
  OPENLORE_ANALYSIS_SUBDIR,
} from '../../constants.js';
import { EdgeStore } from '../services/edge-store.js';
import type { FunctionNode } from '../analyzer/call-graph.js';
import type { StructuralAnchor } from '../../types/index.js';
import {
  hashSpan,
  resolveSymbolAnchors,
  fileAnchor,
  type AnchorNode,
  type GraphFreshnessView,
} from './anchor.js';

function analysisDir(rootPath: string): string {
  return join(rootPath, OPENLORE_DIR, OPENLORE_ANALYSIS_SUBDIR);
}

/** Read a file's content from disk via a cache, or null if unreadable. */
function readFileCached(rootPath: string, filePath: string, cache: Map<string, string | null>): string | null {
  const hit = cache.get(filePath);
  if (hit !== undefined) return hit;
  let content: string | null;
  try {
    content = readFileSync(join(rootPath, filePath), 'utf-8');
  } catch {
    content = null;
  }
  cache.set(filePath, content);
  return content;
}

/** Hash a node's source span by its byte offsets against current file content. */
function hashNodeSpan(rootPath: string, node: FunctionNode, cache: Map<string, string | null>): string | undefined {
  const content = readFileCached(rootPath, node.filePath, cache);
  if (content === null) return undefined;
  // start/end are byte offsets; slice a Buffer to stay byte-accurate for multibyte
  // source. subarray clamps out-of-range indices, so a shrunken file still hashes
  // deterministically (and differs from the original span → drifted).
  const buf = Buffer.from(content, 'utf-8');
  return hashSpan(buf.subarray(node.startIndex, node.endIndex).toString('utf-8'));
}

/**
 * Build a {@link GraphFreshnessView} over an already-open edge store + disk. The
 * view carries its own short-lived file cache. No rename map by default — a
 * missing symbol is `orphaned` unless the caller supplies `renameOf`.
 */
export function makeFreshnessView(
  store: EdgeStore,
  rootPath: string,
  renameOf?: (nodeId: string) => string | undefined,
): GraphFreshnessView {
  const cache = new Map<string, string | null>();
  return {
    nodeHash: (nodeId: string): string | undefined => {
      const node = store.getNode(nodeId);
      return node ? hashNodeSpan(rootPath, node, cache) : undefined;
    },
    fileExists: (filePath: string): boolean => existsSync(join(rootPath, filePath)),
    fileHash: (filePath: string): string | undefined => {
      const content = readFileCached(rootPath, filePath, cache);
      return content === null ? undefined : hashSpan(content);
    },
    renameOf,
  };
}

export class AnchorContext {
  private fileCache = new Map<string, string | null>();

  private constructor(
    private readonly store: EdgeStore,
    private readonly rootPath: string,
  ) {}

  /** Open the adapter, or return null when no analysis (edge store) exists yet. */
  static open(rootPath: string): AnchorContext | null {
    const dir = analysisDir(rootPath);
    if (!EdgeStore.exists(dir)) return null;
    try {
      return new AnchorContext(EdgeStore.open(EdgeStore.dbPath(dir)), rootPath);
    } catch {
      return null;
    }
  }

  close(): void {
    try { this.store.close(); } catch { /* ignore */ }
  }

  private spanHash(node: FunctionNode): string | undefined {
    return hashNodeSpan(this.rootPath, node, this.fileCache);
  }

  /** Build resolvable {@link AnchorNode}s for every internal node in the given files. */
  anchorNodesForFiles(files: readonly string[]): AnchorNode[] {
    const out: AnchorNode[] = [];
    for (const file of new Set(files)) {
      for (const node of this.store.getNodesForFile(file)) {
        if (node.isExternal) continue;
        const contentHash = this.spanHash(node);
        if (contentHash === undefined) continue;
        out.push({ id: node.id, name: node.name, filePath: node.filePath, contentHash });
      }
    }
    return out;
  }

  /** Current whole-file content hash, or undefined when the file is gone. */
  fileContentHash(filePath: string): string | undefined {
    const content = readFileCached(this.rootPath, filePath, this.fileCache);
    return content === null ? undefined : hashSpan(content);
  }

  /** A {@link GraphFreshnessView} backed by this adapter's edge store + disk. */
  freshnessView(): GraphFreshnessView {
    return makeFreshnessView(this.store, this.rootPath);
  }

  /**
   * Resolve anchors for a decision: symbol-level anchors for any function in the
   * affected files whose name is mentioned verbatim in the decision text, plus a
   * file-level anchor (with a captured baseline hash) for each affected file.
   */
  resolveDecisionAnchors(affectedFiles: readonly string[], text: string): StructuralAnchor[] {
    const nodes = this.anchorNodesForFiles(affectedFiles);
    const named = nodes.filter((n) => isNamedIn(text, n.name)).map((n) => n.name);
    const symbolAnchors = resolveSymbolAnchors(named, nodes, affectedFiles);
    const fileAnchors = [...new Set(affectedFiles)].map((f) => fileAnchor(f, this.fileContentHash(f)));
    // Keep both: file anchors give coarse coverage even where no symbol matched.
    return [...symbolAnchors, ...fileAnchors];
  }

  /**
   * Resolve caller-supplied anchor hints (for `remember`). Each hint may name a
   * symbol and/or a file. A symbol that resolves to exactly one node becomes a
   * symbol anchor; otherwise the file (if given) becomes a file anchor.
   */
  resolveInputAnchors(
    hints: ReadonlyArray<{ symbol?: string; file?: string }>,
  ): StructuralAnchor[] {
    const files = hints.map((h) => h.file).filter((f): f is string => !!f);
    const nodes = files.length
      ? this.anchorNodesForFiles(files)
      : this.store.getAllInternalNodes().reduce<AnchorNode[]>((acc, node) => {
          const contentHash = this.spanHash(node);
          if (contentHash !== undefined) {
            acc.push({ id: node.id, name: node.name, filePath: node.filePath, contentHash });
          }
          return acc;
        }, []);

    const out: StructuralAnchor[] = [];
    const seen = new Set<string>();
    for (const hint of hints) {
      if (hint.symbol) {
        const resolved = resolveSymbolAnchors([hint.symbol], nodes, hint.file ? [hint.file] : undefined);
        if (resolved.length === 1) {
          if (!seen.has(resolved[0].nodeId!)) {
            seen.add(resolved[0].nodeId!);
            out.push(resolved[0]);
          }
          continue;
        }
      }
      if (hint.file) {
        const key = `file:${hint.file}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(fileAnchor(hint.file, this.fileContentHash(hint.file)));
        }
      }
    }
    return out;
  }
}

/** Whole-word, case-sensitive mention test for a symbol name in free text. */
export function isNamedIn(text: string, name: string): boolean {
  if (name.length < 3) return false; // too short to be an unambiguous mention
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_])${escaped}([^A-Za-z0-9_]|$)`).test(text);
}

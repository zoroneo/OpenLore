/**
 * SCIP export — derives a valid `index.scip` payload from an OpenLore call
 * graph.
 *
 * SCIP (Source Code Intelligence Protocol) is Sourcegraph's open successor to
 * LSIF. This is a one-way interop export: the SQLite/JSON graph remains
 * canonical, and we lossily project the subset of it that SCIP can model
 * (functions → symbols, call edges → reference/definition occurrences).
 *
 * Guarantees:
 *  - Deterministic: documents sorted by relative path, occurrences by
 *    `(line, col)`, symbols deduplicated and sorted. Re-running on an unchanged
 *    graph produces byte-identical output.
 *  - Faithful or loud: if a node we export lacks a defining line (a range a
 *    SCIP consumer expects), the export throws rather than emitting a malformed
 *    index. Column-level precision is unavailable in the analyzer today, so we
 *    emit zero-width ranges at column 0 and warn once.
 *    TODO(spec-04-followup): column ranges in analyzer.
 *  - TODO(spec-04-followup): scip import (consume external SCIP into the graph).
 */

import type { SerializedCallGraph, FunctionNode } from '../analyzer/call-graph.js';
import {
  scipIndexType,
  SymbolRole,
  TextEncoding_UTF8,
  SymbolKind_Function,
} from './schema.js';
import { symbolMoniker, scipLanguageName, type PackageInfo } from './moniker.js';

export interface ExportScipOptions {
  /** Absolute path to the project root. Emitted (URI-encoded) as project_root. */
  projectRoot: string;
  /** Package coordinates filling the SCIP `<package>` symbol slot. */
  package: PackageInfo;
  /** openlore's own version, emitted as tool_info.version. */
  toolVersion: string;
  /** Gitignore-style globs over repo-relative paths; if set, only matches participate. */
  include?: string[];
  /** Gitignore-style globs over repo-relative paths; matches are dropped. */
  exclude?: string[];
  /** Out-param: populated with summary statistics and warnings for the CLI. */
  report?: ExportReport;
}

export interface ExportReport {
  documentCount: number;
  occurrenceCount: number;
  symbolCount: number;
  definitionCount: number;
  /** Repo-relative paths whose language has no SCIP enum value. */
  unspecifiedLanguageFiles: string[];
  warnings: string[];
}

/**
 * Compile a glob to a path-matching RegExp. Supports `*` (within a segment),
 * `?`, `**` (across segments), and a globstar-plus-slash (zero or more leading
 * path segments).
 * Sufficient for the documented `--include`/`--exclude` patterns; not a full
 * gitignore implementation.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

/** True iff `relPath` matches any of the compiled glob patterns. */
function matchesAny(relPath: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(relPath));
}

/** Normalize a node's file path to a POSIX repo-relative path. */
function toRelPath(filePath: string, projectRoot: string): string {
  let p = filePath.replace(/\\/g, '/');
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  if (p.startsWith(root + '/')) p = p.slice(root.length + 1);
  return p.replace(/^\.\//, '').replace(/^\/+/, '');
}

/** A definition occurrence emitted in the document where the symbol is defined. */
interface ScipOccurrence {
  range: number[];
  symbol: string;
  symbol_roles: number;
}

interface ScipSymbolInformation {
  symbol: string;
  documentation?: string[];
  kind: number;
}

interface ScipDocument {
  language: string;
  relative_path: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

/**
 * Build a deterministic SCIP `index.scip` payload from a serialized call graph.
 * Returns the encoded protobuf bytes.
 */
export function exportScip(graph: SerializedCallGraph, options: ExportScipOptions): Buffer {
  const report: ExportReport = options.report ?? {
    documentCount: 0,
    occurrenceCount: 0,
    symbolCount: 0,
    definitionCount: 0,
    unspecifiedLanguageFiles: [],
    warnings: [],
  };
  if (options.report) {
    // Reset the caller-provided report so repeated calls are clean.
    report.documentCount = 0;
    report.occurrenceCount = 0;
    report.symbolCount = 0;
    report.definitionCount = 0;
    report.unspecifiedLanguageFiles = [];
    report.warnings = [];
  }

  const includePatterns = (options.include ?? []).map(globToRegExp);
  const excludePatterns = (options.exclude ?? []).map(globToRegExp);

  // Real (non-synthetic) nodes that survive the include/exclude filter.
  const exportable = new Map<string, { node: FunctionNode; relPath: string }>();
  for (const node of graph.nodes) {
    if (node.isExternal) continue;
    const relPath = toRelPath(node.filePath, options.projectRoot);
    if (!relPath) continue;
    if (includePatterns.length > 0 && !matchesAny(relPath, includePatterns)) continue;
    if (excludePatterns.length > 0 && matchesAny(relPath, excludePatterns)) continue;
    exportable.set(node.id, { node, relPath });
  }

  // Stable moniker per node id, computed once.
  const monikers = new Map<string, string>();
  for (const [id, { node, relPath }] of exportable) {
    monikers.set(id, symbolMoniker(node, relPath, options.package));
  }

  let warnedMissingColumns = false;
  const warnMissingColumns = (): void => {
    if (warnedMissingColumns) return;
    warnedMissingColumns = true;
    report.warnings.push(
      'Column-level ranges are unavailable in the analyzer; emitted zero-width ranges at column 0. ' +
        'TODO(spec-04-followup): column ranges in analyzer.'
    );
  };

  // documents keyed by relative path.
  const docs = new Map<string, ScipDocument>();
  const seenLanguages = new Map<string, string>(); // relPath -> openlore language
  const docFor = (relPath: string, openloreLang: string): ScipDocument => {
    let doc = docs.get(relPath);
    if (!doc) {
      const language = scipLanguageName(openloreLang);
      if (!language) report.unspecifiedLanguageFiles.push(relPath);
      doc = { language, relative_path: relPath, occurrences: [], symbols: [] };
      docs.set(relPath, doc);
      seenLanguages.set(relPath, openloreLang);
    }
    return doc;
  };

  // 1. Definition occurrence + SymbolInformation for every exported node.
  for (const [, { node, relPath }] of exportable) {
    if (node.startLine === undefined) {
      throw new Error(
        `SCIP export aborted: node "${node.id}" has no defining line. ` +
          'The graph is missing a range that an SCIP consumer requires. ' +
          'Re-run `openlore analyze` to rebuild the graph; if the problem persists the analyzer ' +
          'did not record positions for this language.'
      );
    }
    const doc = docFor(relPath, node.language);
    const symbol = monikers.get(node.id)!;
    const line = node.startLine - 1; // SCIP ranges are 0-based.
    warnMissingColumns();
    doc.occurrences.push({ range: [line, 0, 0], symbol, symbol_roles: SymbolRole.Definition });
    doc.symbols.push({
      symbol,
      kind: SymbolKind_Function,
      ...(node.docstring ? { documentation: [node.docstring] } : {}),
    });
  }

  // 2. Reference occurrence at each call site whose callee we export.
  for (const edge of graph.edges) {
    const caller = exportable.get(edge.callerId);
    const calleeSymbol = monikers.get(edge.calleeId);
    if (!caller || !calleeSymbol) continue; // skip edges to external/filtered nodes.
    const doc = docFor(caller.relPath, caller.node.language);
    if (edge.line === undefined) warnMissingColumns();
    const line = (edge.line ?? caller.node.startLine ?? 1) - 1;
    doc.occurrences.push({ range: [line, 0, 0], symbol: calleeSymbol, symbol_roles: SymbolRole.ReadAccess });
  }

  // 3. Deterministic ordering: documents by path; occurrences by (line, col,
  //    roles, symbol); symbols deduplicated and sorted by symbol string.
  const sortedDocs = [...docs.values()].sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  for (const doc of sortedDocs) {
    doc.occurrences.sort(
      (a, b) =>
        a.range[0] - b.range[0] ||
        a.range[1] - b.range[1] ||
        a.symbol_roles - b.symbol_roles ||
        a.symbol.localeCompare(b.symbol)
    );
    const bySymbol = new Map<string, ScipSymbolInformation>();
    for (const s of doc.symbols) if (!bySymbol.has(s.symbol)) bySymbol.set(s.symbol, s);
    doc.symbols = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

    report.occurrenceCount += doc.occurrences.length;
    report.symbolCount += doc.symbols.length;
    report.definitionCount += doc.occurrences.filter(o => o.symbol_roles === SymbolRole.Definition).length;
  }
  report.documentCount = sortedDocs.length;

  const payload = {
    metadata: {
      version: 0, // UnspecifiedProtocolVersion — the only defined value.
      tool_info: { name: 'openlore', version: options.toolVersion },
      project_root: pathToFileUri(options.projectRoot),
      text_document_encoding: TextEncoding_UTF8,
    },
    documents: sortedDocs,
  };

  const Index = scipIndexType();
  const err = Index.verify(payload);
  if (err) throw new Error(`SCIP export produced an invalid index: ${err}`);
  const message = Index.create(payload);
  return Buffer.from(Index.encode(message).finish());
}

/** Encode an absolute filesystem path as a `file://` URI for project_root. */
function pathToFileUri(absPath: string): string {
  const normalized = absPath.replace(/\\/g, '/');
  const withSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return 'file://' + withSlash.split('/').map(encodeURIComponent).join('/');
}

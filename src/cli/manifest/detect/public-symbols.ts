/**
 * Derive the public API surface from data the analyzer already produced.
 *
 * Default (conservative, per spec-05): a symbol is "public" if it is exported
 * from the *package entry point(s)* (TS/JS), following re-exports to their
 * definition for an accurate kind/line. Public methods of an exported class are
 * included too (e.g. `BillingService.refund`). For files in languages the
 * export extractor does not cover, we fall back to "top-level non-underscore
 * function" (matching the Python `__all__`/non-underscore convention).
 *
 * `--include-private` drops the public filter entirely and emits every
 * file-level export plus every function/method node (a much larger list).
 *
 * Sources:
 *  - dependency-graph.json `exports[]` — name/kind/line/isReExport per file.
 *  - the call graph — public methods of exported classes, with lines.
 *
 * We do NOT add new language parsers here (spec-05 scope).
 * TODO(spec-05-followup): surface exported types/interfaces with line numbers.
 */

import type { FunctionNode, ClassNode } from '../../../core/analyzer/call-graph.js';

export interface ExportEntry {
  name: string;
  kind: string;
  line: number;
  isType?: boolean;
  isDefault?: boolean;
  isReExport?: boolean;
  reExportSource?: string;
}

export interface PublicSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
}

/** A name is "public-looking" if it is not underscore/hash-prefixed. */
function isPublicName(name: string): boolean {
  return !/^[_#]/.test(name);
}

/** Resolve `./foo.js` (relative to `fromFile`) to a repo-relative `.ts` path. */
function resolveReExportTarget(fromFile: string, source: string): string {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const parts = (dir ? `${dir}/${source}` : source).split('/');
  const stack: string[] = [];
  for (const p of parts) {
    if (p === '.' || p === '') continue;
    if (p === '..') stack.pop();
    else stack.push(p);
  }
  return stack.join('/').replace(/\.js$/, '.ts');
}

/** Look up a definition in the call graph (the reliable source for line/kind). */
type CallGraphLookup = (file: string, name: string) => PublicSymbol | null;

/**
 * Resolve an entry-point export to its defining {kind, file, line}, following
 * re-export hops. Prefers the call graph for accurate lines; the export
 * extractor does not always record a re-export target's own exports.
 */
function resolveExport(
  entry: ExportEntry,
  file: string,
  exportsByFile: Map<string, ExportEntry[]>,
  lookup: CallGraphLookup,
  depth = 0
): PublicSymbol {
  if (entry.isReExport && entry.reExportSource && depth <= 4) {
    const target = resolveReExportTarget(file, entry.reExportSource);
    const match = exportsByFile.get(target)?.find(e => e.name === entry.name);
    if (match) return resolveExport(match, target, exportsByFile, lookup, depth + 1);
    const fromGraph = lookup(target, entry.name);
    if (fromGraph) return fromGraph;
    return { name: entry.name, kind: 'symbol', file, line: entry.line };
  }
  // Direct export — prefer the call graph's line/kind when it knows the symbol.
  return (
    lookup(file, entry.name) ?? {
      name: entry.name,
      kind: entry.kind === 'unknown' ? 'symbol' : entry.kind,
      file,
      line: entry.line,
    }
  );
}

export interface DerivePublicSymbolsArgs {
  nodes: FunctionNode[];
  classes: ClassNode[];
  exportsByFile: Map<string, ExportEntry[]>;
  /** Repo-relative entry-point source files (from package.json), TS/JS. */
  entryFiles: string[];
  includePrivate: boolean;
}

export function derivePublicSymbols(args: DerivePublicSymbolsArgs): PublicSymbol[] {
  const { nodes, classes, exportsByFile, entryFiles, includePrivate } = args;
  const byKey = new Map<string, PublicSymbol>();

  // Call-graph indices for resolving re-exported definitions to file+line.
  const freeFnIndex = new Map<string, FunctionNode>();
  for (const n of nodes) {
    if (!n.isExternal && !n.isTest && !n.className) freeFnIndex.set(`${n.filePath}::${n.name}`, n);
  }
  const classIndex = new Map<string, ClassNode>();
  for (const c of classes) classIndex.set(`${c.filePath}::${c.name}`, c);
  const lookup: CallGraphLookup = (file, name) => {
    const fn = freeFnIndex.get(`${file}::${name}`);
    if (fn) return { name, kind: 'function', file, line: fn.startLine ?? 0 };
    const cls = classIndex.get(`${file}::${name}`);
    if (cls) return { name, kind: 'class', file, line: 0 };
    return null;
  };
  const add = (s: PublicSymbol): void => {
    const key = `${s.file}::${s.name}`;
    if (!byKey.has(key)) byKey.set(key, s);
  };

  // Methods of a class, keyed for the "expand exported class" step.
  const methodsByClass = new Map<string, FunctionNode[]>();
  for (const n of nodes) {
    if (n.isExternal || n.isTest || !n.className) continue;
    const key = `${n.filePath}::${n.className}`;
    (methodsByClass.get(key) ?? methodsByClass.set(key, []).get(key)!).push(n);
  }
  const addPublicMethods = (className: string, file: string): void => {
    for (const m of methodsByClass.get(`${file}::${className}`) ?? []) {
      if (isPublicName(m.name) && !/\bprivate\b/.test(m.signature ?? '')) {
        add({ name: `${className}.${m.name}`, kind: 'method', file, line: m.startLine ?? 0 });
      }
    }
  };

  if (includePrivate) {
    // Everything: all file-level exports + all function/method nodes.
    for (const [file, entries] of exportsByFile) {
      for (const e of entries) add({ name: e.name, kind: e.kind, file, line: e.line });
    }
    for (const n of nodes) {
      if (n.isExternal || n.isTest) continue;
      const name = n.className ? `${n.className}.${n.name}` : n.name;
      add({ name, kind: n.className ? 'method' : 'function', file: n.filePath, line: n.startLine ?? 0 });
    }
  } else {
    // Default: only the package entry point's exports (resolved), TS/JS.
    const filesWithExports = new Set(exportsByFile.keys());
    for (const entryFile of entryFiles) {
      for (const e of exportsByFile.get(entryFile) ?? []) {
        if (e.isType) continue;
        const resolved = resolveExport(e, entryFile, exportsByFile, lookup);
        add(resolved);
        if (resolved.kind === 'class') addPublicMethods(resolved.name, resolved.file);
      }
    }
    // Fallback for languages/files without export info: top-level non-underscore
    // free functions (covers Python etc. conservatively).
    for (const n of nodes) {
      if (n.isExternal || n.isTest || n.className) continue;
      if (filesWithExports.has(n.filePath)) continue;
      if (isPublicName(n.name)) add({ name: n.name, kind: 'function', file: n.filePath, line: n.startLine ?? 0 });
    }
  }

  return [...byKey.values()].sort(
    (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.name.localeCompare(b.name)
  );
}

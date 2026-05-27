/**
 * Derivation of SCIP symbol monikers and language tags from OpenLore graph
 * nodes.
 *
 * SCIP symbols are formatted strings, not structured objects, per the grammar
 * documented at https://github.com/sourcegraph/scip/blob/main/docs/scip.md.
 * We emit global symbols of the form:
 *
 *   <scheme> ' ' <manager> ' ' <package-name> ' ' <version> <descriptors>
 *
 * where descriptors are `<repo-rel-path>/` (namespace) followed by
 * `<qualified-name>(<arity>).` (method). Example:
 *
 *   openlore npm openlore 2.0.2 `src/core/scip/index.ts`/exportScip(1).
 *
 * Identifiers containing characters outside the SCIP "simple identifier" set
 * are backtick-escaped (with embedded backticks doubled).
 */

import type { FunctionNode } from '../analyzer/call-graph.js';

/** Package coordinates that fill the SCIP `<package>` slot of every symbol. */
export interface PackageInfo {
  manager: string;
  name: string;
  version: string;
}

const SCHEME = 'openlore';

/** A simple identifier needs no escaping iff it matches this set entirely. */
const SIMPLE_IDENTIFIER = /^[A-Za-z0-9\-+$_]+$/;

/** Escape a name for use as a SCIP descriptor identifier. */
function escapeName(name: string): string {
  if (SIMPLE_IDENTIFIER.test(name)) return name;
  // Escaped identifier: wrap in backticks, double any embedded backticks.
  return '`' + name.replace(/`/g, '``') + '`';
}

/**
 * Map an OpenLore language tag (see signature-extractor.ts) to the SCIP
 * `Language` enum name used as `Document.language`. Returns `''` for languages
 * SCIP has no value for (the caller records these for the export summary).
 */
export function scipLanguageName(openloreLanguage: string): string {
  switch (openloreLanguage) {
    case 'Python':
    case 'TypeScript':
    case 'JavaScript':
    case 'Go':
    case 'Rust':
    case 'Ruby':
    case 'Java':
    case 'Kotlin':
    case 'PHP':
    case 'Swift':
    case 'C':
      return openloreLanguage;
    case 'C++':
      return 'CPP';
    case 'C#':
      return 'CSharp';
    default:
      // 'unknown' and anything SCIP lacks an enum value for.
      return '';
  }
}

/** Fully-qualified name within a file: `Class.method` or bare `function`. */
export function qualifiedName(node: FunctionNode): string {
  return node.className ? `${node.className}.${node.name}` : node.name;
}

/**
 * Best-effort parameter count from a node's declaration `signature`. Counts
 * top-level comma-separated parameters inside the first parenthesized group.
 * Returns `undefined` when no signature is available (the analyzer does not
 * persist arity directly — TODO(spec-04-followup): arity in analyzer).
 */
export function arityOf(node: FunctionNode): number | undefined {
  const sig = node.signature;
  if (!sig) return undefined;
  const open = sig.indexOf('(');
  if (open === -1) return undefined;
  // Walk to the matching close paren, counting top-level commas.
  let depth = 0;
  let commas = 0;
  let sawContent = false;
  for (let i = open; i < sig.length; i++) {
    const ch = sig[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') {
      depth--;
      if (depth === 0) break;
    } else if (ch === ',' && depth === 1) commas++;
    else if (depth === 1 && !/\s/.test(ch)) sawContent = true;
  }
  if (!sawContent) return 0;
  return commas + 1;
}

/**
 * Build the SCIP symbol moniker string for a function node.
 *
 * `repoRelPath` must be the document's relative path (POSIX separators), the
 * same value used for the node's `Document.relative_path`.
 */
export function symbolMoniker(node: FunctionNode, repoRelPath: string, pkg: PackageInfo): string {
  const namespace = `${escapeName(repoRelPath)}/`;
  const arity = arityOf(node);
  const disambiguator = arity === undefined ? '' : String(arity);
  const method = `${escapeName(qualifiedName(node))}(${disambiguator}).`;
  return `${SCHEME} ${pkg.manager} ${pkg.name} ${pkg.version} ${namespace}${method}`;
}

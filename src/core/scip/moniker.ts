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
 * Index of the `(` that opens the PARAMETER group in a captured signature, or
 * `-1` when there is none. Normally the first `(`, but a Go method signature is
 * `func (recv) Name(params)` — the first `(` is the *receiver*, not the params —
 * so when the text immediately before the first `(` is exactly the `func`
 * keyword (no method name between), the receiver group is skipped and the next
 * `(` is returned. Free functions (`func Name(params)`) and every other language
 * keep the first `(`. This keeps Go method identity keyed on real parameters, not
 * the receiver variable.
 */
function parameterGroupStart(sig: string): number {
  const first = sig.indexOf('(');
  if (first === -1) return -1;
  if (sig.slice(0, first).trim() !== 'func') return first;
  // Go method: skip the balanced receiver group, then take the next '('.
  let depth = 0;
  for (let i = first; i < sig.length; i++) {
    if (sig[i] === '(') depth++;
    else if (sig[i] === ')' && --depth === 0) {
      const next = sig.indexOf('(', i + 1);
      return next; // -1 if a receiver-only form (no param group) — handled by callers
    }
  }
  return first; // unbalanced receiver — fall back to the first group
}

/**
 * Best-effort parameter count from a node's declaration `signature`. Counts
 * top-level comma-separated parameters inside the parameter group.
 * Returns `undefined` when no signature is available (the analyzer does not
 * persist arity directly — TODO(spec-04-followup): arity in analyzer).
 */
export function arityOf(node: FunctionNode): number | undefined {
  const sig = node.signature;
  if (!sig) return undefined;
  const open = parameterGroupStart(sig);
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

/** Prefix marking a content-addressed stable id; never collides with a path-based
 *  `id` (which is `<filePath>::<name>` and contains no leading `sid:`). */
const STABLE_ID_PREFIX = 'sid:';

/**
 * Normalized signature shape: the balanced parenthesized parameter group only,
 * identifier removed, whitespace-collapsed (e.g. `(a: number, b: string)`).
 * Shared by {@link stableSymbolId} (overload disambiguator) and structural-diff's
 * rename-recovery heuristic, so both agree on one notion of "same shape".
 *
 * Deliberately bounded to the parameter list — it excludes everything *after* the
 * matching close paren, which matters for two reasons:
 *  - Leading modifiers/the name (a rename, `async`/`export`/visibility) and the
 *    trailing return type are NOT in the shape, so a change confined to those
 *    keeps a symbol's `stableId` and is reported as *modified*, not remove+add.
 *  - For expression-bodied arrows (`const f = (a) => a.length`) the analyzer's
 *    captured `signature` includes the body; bounding to the param group keeps the
 *    `stableId` BODY-INVARIANT — essential so a moved-and-edited symbol resolves as
 *    `drifted` (not `orphaned`) via its anchor's `stableId`.
 *
 * For a Go method (`func (recv) Name(params)`) the leading receiver group is
 * skipped (see {@link parameterGroupStart}) so the shape is the real parameters,
 * not the receiver variable. Returns `''` when there is no parameter group.
 */
export function signatureShape(signature: string | undefined): string {
  if (!signature) return '';
  const open = parameterGroupStart(signature);
  if (open === -1) return '';
  // Walk to the matching close paren (tracking nesting), then slice the group.
  let depth = 0;
  for (let i = open; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) {
      return signature.slice(open, i + 1).replace(/\s+/g, ' ').trim();
    }
  }
  // Unbalanced (truncated capture) — take from '(' to end, normalized.
  return signature.slice(open).replace(/\s+/g, ' ').trim();
}

/** Per-segment-escaped qualified name: `Class.method` or bare `function`, each
 *  segment escaped independently (SCIP descriptors escape per segment, not the
 *  dotted whole). */
function escapedQualifiedName(node: FunctionNode): string {
  const base = escapeName(node.name);
  return node.className ? `${escapeName(node.className)}.${base}` : base;
}

/** True when a symbol name is a real, derivable descriptor — not anonymous, a
 *  synthetic module/test wildcard (`*`), or a generated `<...>` placeholder. */
function hasDerivableName(name: string | undefined): boolean {
  return !!name && name !== 'anonymous' && !name.includes('*') && !/^<.*>$/.test(name);
}

/**
 * Content-addressed, location-independent stable identity for a function symbol.
 * (change: add-content-addressed-stable-symbol-ids)
 *
 * A pure function of the symbol's OWN structure: the qualified name
 * (`Class.method` or bare function) plus the normalized {@link signatureShape}
 * (the parameter group). It deliberately excludes the repo-relative path that
 * {@link symbolMoniker} bakes into its namespace AND the function body, so a
 * symbol keeps its identity across a file rename/move and across body edits.
 *
 * A function id always carries a `(...)` parameter group (empty `()` when no
 * signature was captured), so it never collides with a {@link stableClassId} of
 * the same name (classes carry none).
 *
 * Because the id is content-only, two genuinely distinct symbols that share a
 * qualified name and parameter shape (homonyms) receive the SAME `stableId`. This
 * is intentional: the change never fabricates a position-dependent discriminator
 * (which a file rename/add/remove would silently flip). Consumers resolve a
 * `stableId` only when it identifies a UNIQUE symbol (see
 * `EdgeStore.getNodeByStableId`) and otherwise fall back rather than guess.
 *
 * Returns `undefined` for symbols with no derivable descriptor (anonymous or
 * synthetic), which keep only their path-based `id`.
 */
export function stableSymbolId(node: FunctionNode): string | undefined {
  if (!hasDerivableName(node.name)) return undefined;
  const shape = signatureShape(node.signature);
  return `${STABLE_ID_PREFIX}${escapedQualifiedName(node)}${shape || '()'}`;
}

/**
 * Stable id for a class symbol: the escaped class name only (a class has no
 * parameter group, so it never collides with a function's `sid:Name(...)`).
 * Returns `undefined` for synthetic module groupings and non-derivable names.
 * Like {@link stableSymbolId}, homonym classes share an id and resolve only when
 * unique.
 */
export function stableClassId(name: string, isModule?: boolean): string | undefined {
  if (isModule || !hasDerivableName(name)) return undefined;
  return `${STABLE_ID_PREFIX}${escapeName(name)}`;
}

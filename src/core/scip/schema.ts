/**
 * Loads the vendored SCIP protobuf schema and exposes the `scip.Index` type.
 *
 * The schema is vendored verbatim at `vendor/scip.proto` (pinned — see the
 * header comment in that file). We parse it at runtime with protobufjs (pure
 * JS, no native build) rather than committing a generated `pb.js`, which keeps
 * the vendored artifact human-readable and trivially re-fetchable.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import protobuf from 'protobufjs';

/** Resolved once and memoized — parsing the proto is cheap but not free. */
let cachedRoot: protobuf.Root | undefined;

/** Absolute path to the vendored proto, resolved relative to this module. */
export function scipProtoPath(): string {
  return fileURLToPath(new URL('./vendor/scip.proto', import.meta.url));
}

/** Parse the vendored proto and return the protobufjs Root. */
export function loadScipRoot(): protobuf.Root {
  if (cachedRoot) return cachedRoot;
  const protoText = readFileSync(scipProtoPath(), 'utf-8');
  cachedRoot = protobuf.parse(protoText, { keepCase: true }).root;
  return cachedRoot;
}

/** The `scip.Index` message type, used to verify + serialize an index payload. */
export function scipIndexType(): protobuf.Type {
  return loadScipRoot().lookupType('scip.Index');
}

/**
 * SCIP `SymbolRole` bitset values we use. Mirrors the enum in scip.proto.
 * Kept as a const object (not an import) because the proto enums are not
 * surfaced as TS values by protobufjs's runtime parse.
 */
export const SymbolRole = {
  Definition: 0x1,
  ReadAccess: 0x8,
} as const;

/**
 * SCIP `TextEncoding.UTF8`. The index declares source files are UTF-8 on disk.
 */
export const TextEncoding_UTF8 = 1;

/**
 * SCIP `SymbolInformation.Kind.Function`. Every node we export is a
 * function/method, so we tag them uniformly.
 */
export const SymbolKind_Function = 17;

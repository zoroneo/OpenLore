// Ambient declarations for spec-08 modules that ship no usable types.
// Lua and Dart are loaded via portable WASM (tree-sitter-wasms) through
// web-tree-sitter, which we access through a minimal structural interface.
declare module 'web-tree-sitter';

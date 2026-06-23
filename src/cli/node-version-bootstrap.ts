/**
 * Bootstrap that runs the Node-version guard as an import side effect.
 *
 * Why a separate module: ES module imports are hoisted — a top-level
 * `assertSupportedNode()` STATEMENT in `index.ts` would run only after every
 * imported module body (commander + all command modules) had already evaluated,
 * defeating "fail before anything heavy loads". ESM instead evaluates a module's
 * dependencies in source order, each fully before the next. So importing THIS
 * module first (and it being dependency-free apart from the guard) makes the guard
 * — and its `process.exit` on an unsupported Node — run before commander's body.
 *
 * `node-version-guard.ts` stays side-effect-free so its pure checker can be unit
 * tested without exiting the test process.
 */
import { assertSupportedNode } from './node-version-guard.js';

assertSupportedNode();

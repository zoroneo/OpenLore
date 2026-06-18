# Tasks — Widen JS/TS function-node extraction

> Status: IMPLEMENTED (2026-06-18). Decision `d8b81a9b` recorded before code. Deterministic,
> no LLM, no new deps. Additive: the new shapes only add nodes; existing shapes are unchanged.

## 1. Extraction query
- [x] Add a `variable_declaration` arm to `TS_FN_QUERY` mirroring the existing `lexical_declaration`
      arm (binds `var f = function|arrow`).
- [x] Add an `assignment_expression` arm with `left: [(identifier) (member_expression)]` and
      `right: [(arrow_function) (function_expression)]` so `obj.prop = fn`, `exports.x = fn`,
      `X.prototype.y = fn`, and `f = fn` are captured. RHS constrained to function/arrow so
      `exports.x = require(...)`, `obj.prop = 42`, and object literals never match.

## 2. Naming & identity
- [x] Name member-assigned nodes by the full dotted LHS text (`app.use`, `Foo.prototype.bar`),
      collapsing incidental whitespace (LHS split across lines) so name/id/stableId stay stable.
- [x] Verify dotted names are backtick-escaped by `stableSymbolId` (the `.` is outside the SCIP
      simple-identifier set) and that re-assignment collapses via the existing id-keyed last-wins
      `allNodes.set(id, …)` (no duplicate explosion).

## 3. Tests (unit)
- [x] One node per new shape with the right name: `exports.handler`, `app.use`/`app.lazyrouter`,
      `View.prototype.render`, bare `f = function`, `var parse`/`var format`, member arrow.
- [x] Edge resolves through a member-assigned function (`exports.handler → helper`,
      `app.use → app.lazyrouter`).
- [x] Negatives: `require(...)`, number, object-literal RHS extract nothing; re-assignment → 1 node;
      member node carries an escaped `stableId`.

## 4. Regression & adversarial review
- [x] Full `vitest run src` green (185 files, 3872 passed / 2 skipped), `typecheck` + `eslint` clean.
- [x] Adversarial fixture: computed-member `obj[key] = fn` and augmented `obj.x ||= fn` are NOT
      indexed; a chained `exports.a = exports.b = fn` indexes only the inner `exports.b`.
- [x] Node-explosion check: re-analyzed this repo's `src/` (1979 internal nodes) — no explosion, no
      malformed member names introduced (the only space-bearing names are pre-existing Ansible
      fixtures).

## 5. Real-input dogfood (see DOGFOOD-widen-js.md)
- [x] Express 5.2.1 `lib/` (real npm tarball): `application.js` 18 nodes (was ~2), `response.js` 29 —
      `app.*`/`res.*` members indexed; `app.render → tryRender`, `res.sendFile → sendfile` resolve;
      `express.js` `exports.x = require(...)` re-exports correctly excluded.
- [x] Django-admin jQuery-plugin idiom: `$.fn.djangoAdminSelect2 = function(){}` now indexed (the
      handler `formset:added` event synthesis was previously starved of).

## 6. Docs & spec
- [x] Spec delta `specs/analyzer/spec.md` (this change) + new requirement merged into
      `openspec/specs/analyzer/spec.md` (`TypeScriptFunctionNodeExtractionShapes`).
- [x] Proposal status flipped DRAFT → IMPLEMENTED with dogfood evidence.

## Known limitations (out of scope, documented)
- Arity/`signatureShape` may be empty for named/anonymous function-expression assignments whose inner
  name differs from the assigned member (`app.use = function use(...)`); the `stableId` stays valid,
  just less precise. Member-assigned **arrows** get full arity.
- `async` on assignment nodes follows the existing `fnNode.text` heuristic (the same under-detection
  already present for arrow `const`s); not changed here.
- `this.x = fn` inside a class body associates with the enclosing class name.
- Object-literal `pair` values (`{ prop: function(){} }`) remain out of scope; only assignment and
  `var`/`const`/`let` bindings are added.

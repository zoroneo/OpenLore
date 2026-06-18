# Dogfood — widen-js-function-node-extraction (2026-06-18)

Real-input, end-to-end verification of the widened TS/JS function-node extraction, run with the
**built CLI** (`dist/cli/index.js`, `npm run build`) against real third-party source — not fixtures.

## 1. Express 5.2.1 `lib/` (real npm tarball)

```
npm pack express@^5   →   express-5.2.1.tgz   →   tar xzf
openlore init && openlore analyze . --no-embed   (161 functions)
```

Internal nodes per file (`sqlite3 .openlore/analysis/call-graph.db`):

| file | nodes | before (proposal estimate) |
|------|-------|----------------------------|
| `lib/response.js`    | 29 | ~handful |
| `lib/application.js` | 18 | **~2** |
| `lib/utils.js`       | 9  | |
| `lib/request.js`     | 8  | |
| `lib/view.js`        | 5  | |
| `lib/express.js`     | 2  | |

`application.js` nodes now include the member methods that were previously invisible:
`app.use`, `app.handle`, `app.set`, `app.listen`, `app.route`, `app.param`, `app.render`,
`app.engine`, `app.init`, `app.defaultConfiguration`, `app.enable/disable/enabled/disabled`,
`app.all`, `app.path`, plus the module-scope helpers `logerror`, `tryRender`.

`response.js`: `res.send`, `res.json`, `res.jsonp`, `res.cookie`, `res.download`, `res.format`,
`res.get`, `res.header`, `res.append`, `res.attachment`, `res.clearCookie`, … (29 total).

**Edges now resolve through member methods** (impossible before — the enclosing function wasn't a
node, so every call site inside it was dropped):
- internal: `app.render → tryRender`, `res.sendFile → sendfile`
- outward: `res.send → setCharset/get/isBuffer/byteLength/etagFn`, `res.json → get`, `res.jsonp → …`

**Negative case holds.** `lib/express.js` is almost entirely `exports.X = require(...)` /
`exports.X = proto` / `exports.json = bodyParser.json`. It produced exactly **2** nodes —
`createApplication` (a real function) and `app` (a `var`-bound function expression). None of the
`require(...)` / member-access / identifier RHS assignments were indexed.

## 2. Django-admin jQuery-plugin idiom

Faithful reproduction of the `$.fn.djangoAdminSelect2 = function(){}` plugin + a CommonJS prototype
class. Extracted nodes:

```
$.fn.djangoAdminSelect2     ← the formset:added handler, previously NOT indexed
Widget
Widget.prototype.render
Widget.prototype.template
init
```

The plugin handler the proposal called out (the one that made `formset:added` resolve only 1 of 2
handlers) is now a first-class node available to the event-synthesis rules.

## 3. Adversarial fixture

| source | indexed? |
|--------|----------|
| `obj[key] = function(){}` (computed member) | **no** (correct) |
| `obj.maybe ||= function(){}` (augmented)     | **no** (correct) |
| `exports.a = exports.b = function(){}` (chained) | only `exports.b` (correct — outer RHS is an assignment, not a function) |
| `function control(){}` | yes |
| `{ method(){}, prop: function(){} }` | `method` only (existing `method_definition`; `pair` value out of scope) |

## 4. Node-explosion / name-quality sanity (this repo's `src/`)

Re-analyzed a copy of OpenLore's own `src/` with the new build: **1979 internal nodes** — no
explosion. The only node names containing whitespace are six **pre-existing** Ansible YAML fixtures
(`task:…`, `handler:…`); the JS/TS change introduced none. A real member node (`r.onload`) extracts
cleanly.

## 5. Suite

`vitest run src`: **185 files, 3872 passed / 2 skipped / 0 failed** (9 new tests over the v2.1.0
baseline of 3863). `typecheck` + `eslint` clean.

**0 functional bugs found.**

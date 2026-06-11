# Tasks — Synthesized dynamic-dispatch edges with provenance

Ordered so each step is independently verifiable. Call `record_decision` before writing code for
step 1 (it extends a core data structure — `EdgeConfidence` / `CallEdge`).

> **Implementation status (PR: feat/synthesized-dynamic-dispatch-edges):** ALL steps (1–6) done.
> - §1: `EdgeConfidence` gains `'synthesized'`; `CallEdge` gains `synthesizedBy?`; `CALL_DISTANCE_COSTS`
>   + `callDistance` give synthesized a strictly-higher cost (4) than any directly-resolved confidence.
> - §2–4: a deterministic post-resolution pass (`synthesizeDynamicDispatchEdges` in `call-graph.ts`,
>   run as build Pass 2d) with two independent rules — **event-channel** (`on/once/addListener/
>   addEventListener` ↔ `emit/dispatch` on a shared static-literal key, cross-file, fan-out capped at 8
>   with over-cap channels dropped + logged) and **route-handler** (reuses the existing route extractors,
>   wiring each route's enclosing function to its handler). Decision recorded: `1f1af089`.
> - §5: synthesized edges are traversed by default (so handlers stop being false-dead — the
>   `reachability.ts` HONEST-LIMITS false positive is retired); a `directResolvedOnly` strict mode is
>   threaded through `buildAdjacency`/`bfsFromDB` to `find_dead_code`, `analyze_impact`, `get_subgraph`,
>   `find_path`, and `select_tests`; a candidate reached only via a synthesized edge is downgraded to
>   `low` with the rule named.
> - §6: regression suites + a real-analyze e2e (through the compiled CLI) pass.
>
> Tests: `edge-synthesis.test.ts` (rules, provenance, fan-out cap, cross-file, route→handler),
> `reachability-synthesis.test.ts` (no false dead, strict mode, downgrade), `call-graph.test.ts`
> (distance exhaustiveness + synthesized > direct). No MCP tool added; default/minimal surface
> unchanged in size.
>
> **Deepening pass (follow-up commit, same PR):** widened the logic where it stays deterministic and
> high-precision —
> - event-channel handler shapes: bare / `this.fn` / `obj.fn` member refs, `.bind()` unwrap, and
>   inline arrow/function handlers (wired to the internal functions their body calls);
> - more verbs: `prependListener`/`prependOnceListener`, pub/sub `subscribe`/`publish`, and DOM
>   `dispatchEvent(new Event|CustomEvent('k'))` key extraction (a keyless `subscribe(fn)` is still
>   ignored — no false edge);
> - route-handler resolves qualified `Class.method` handler names; dead-code now seeds route-handler
>   targets as liveness roots (framework-invoked), so an enclosed route whose setup is itself unreached
>   still keeps its handler live (omitted in strict mode);
> - `directResolvedOnly` strict mode extended to `trace_execution_path` (now all six traversal tools);
> - synthesized edges carry the dispatch-site `line` for provenance.
> Verified end-to-end through the compiled CLI on a really-analyzed repo.
>
> **Structural-metric isolation (integration pass, same PR):** synthesis augments *reachability*
> only — it must not perturb the directly-resolved graph's *structural* metrics, or one heuristic
> edge could manufacture false hubs/bridges/surprises. So: `fanIn`/`fanOut` (and the hub/god/
> entry-point classification + dashboards built on them) now EXCLUDE synthesized edges; the
> betweenness/bridge and untested-hotspot signals and the surprising-connections scorer compute on
> directly-resolved edges. Reachability, impact, dead-code, and the path tools still traverse the
> full edge list (synthesized included) by default, with `directResolvedOnly` to opt out. New
> invariant test: synthesized edges leave `fanIn`/`fanOut` unchanged.
>
> **Provenance fidelity + key coverage (same PR):**
> - the persisted edge store gained a `synthesized_by` column (SCHEMA_VERSION 5→6, rebuild-on-open)
>   so the rule name survives into the SQLite-backed tools; `get_subgraph` now flags synthesized
>   edges (`synthesized: true` + `synthesizedBy`) so an agent sees which edges rest on a heuristic;
> - event-channel keys now also pair on a **constant member reference** (`EVENTS.MOUNT`) and a
>   **substitution-free template literal** (`` `mount` ``), namespaced (`str:` vs `const:`) so a
>   string key never pairs with a same-text constant; a computed/dynamic key still emits nothing.
>
> **Multi-language event channels (spec: `MultiLanguageEventChannelSynthesis`; added one language at
> a time, same PR):** the event-channel rule is now language-pluggable — a shared, language-agnostic
> pairing/fan-out/provenance core plus a per-language site collector (its own AST node types). Sites
> pair only WITHIN their own language (no cross-language pairing), and adding a language cannot change
> another language's edges. In effect: **JavaScript/TypeScript** and **Python** (pyee `on`/`emit`,
> pub/sub `subscribe`/`publish`; handler may be a function ref, `self.method` attribute, or inline
> `lambda`; string + `Const.MEMBER` keys; f-strings ignored). Next languages drop in as additional
> collectors.
>
> Languages with a collector: **JS/TS**, **Python**, **Ruby** (symbol `:evt` + string keys; block,
> `&proc`, and bareword-call handlers; pyee-style `on`/`emit` and ActiveSupport::Notifications
> `subscribe`/`instrument`), **PHP** (Laravel `Event::listen`/`event()`, Symfony `addListener`/
> `dispatch`; handler = `'fn'` string callable, `[$this, 'method']` array callable, or a closure).
> Symbol keys and string keys are namespaced so `:mount` never pairs with `'mount'`.
>
> **Type-based events (spec: `TypeBasedEventSynthesis`; `synthesizedBy: 'type-event'`):** Java and C#
> key on the event TYPE, not a string. A second rule (shared pairing core, distinct label) recovers:
> **Java** — `@Subscribe`/`@EventListener`/`@TransactionalEventListener` handler methods (first
> parameter type = the event) paired with `post(new T(...))` / `publishEvent(new T(...))`; **C#** — a
> class implementing `INotificationHandler<T>` / `IRequestHandler<T>` / `IConsumer<T>` (the method
> taking `T` is the handler) paired with `Publish(new T(...))` / `Send(new T(...))`. The key is
> `type:T`; a dispatch whose argument is not a `new T(...)` construction emits nothing. Channel-based
> languages with no statically-pairable idiom (Go, Rust, Elixir process-based PubSub, …) still have NO
> collector — the pass emits nothing rather than guess.
>
> **All top languages covered (same PR).** String-key event-channel: **JS/TS, Python, Ruby, PHP,
> Swift** (NotificationCenter `addObserver(forName:){closure}` ↔ `post(name:)`, `Notification.Name`
> keys). Type-based: **Java, C#, Kotlin** (Kotlin reuses the JVM annotation model; construction is
> `T(...)` not `new T(...)`). Eight languages across two rules. Also fixed: C#'s capitalized `Main`
> is now recognized as a dead-code liveness root (was only `main`/`default`). Remaining OpenLore
> languages (Go, Rust, C/C++, Scala, Elixir, Lua, Bash, Dart) have no statically-pairable key+handler
> or type+handler event idiom, so by design they get no collector.
>
> **Callback-registration rule (spec: `CallbackRegistrationSynthesis`; `synthesizedBy:
> 'callback-registration'`).** A NAMED internal function passed to a curated registrar that the
> framework/runtime later invokes → edge from the registration's enclosing function to the handler
> (route-handler generalized; no in-code dispatch to pair). **Go** (`net/http` `HandleFunc`/`Handle`
> + gin/echo/chi router verbs) and **JS/TS** (schedulers `setTimeout`/`setInterval`/`setImmediate`/
> `queueMicrotask`/`requestAnimationFrame`/`requestIdleCallback`/`nextTick`). Only curated registrars
> match (a function passed to an unrelated call is never a callback); inline closures are skipped
> (direct resolution already attributes their bodies). This is what makes Go HTTP handlers — which
> route detection does not cover for Go — reachable instead of false-dead.

## 1. Provenance on the edge model
- [ ] Add `'synthesized'` to `EdgeConfidence` (`call-graph.ts:30`) and `synthesizedBy?: string` to
      `CallEdge` (`call-graph.ts:106-118`).
- [ ] Add a `'synthesized'` arm to `CALL_DISTANCE_COSTS` (`call-graph.ts:100`) with a cost strictly
      greater than any directly-resolved confidence, and an exhaustive switch arm in `callDistance`
      (`call-graph.ts:125`). → verify: `call-graph.test.ts` exhaustiveness test stays green.
- [ ] Confirm graph serialization round-trips edges with and without `synthesizedBy`.

## 2. Synthesis pass scaffold
- [ ] Add a deterministic post-resolution pass that runs after direct edges are built, structured as
      a registry of independent per-pattern rules. → verify: pass is a no-op when no patterns match
      (directly-resolved graph byte-identical).

## 3. Event-channel rule
- [ ] Pair `on(k, fn)` / `addEventListener(k, fn)` registrations with `emit(k)` / `dispatch(k)`
      dispatch sites on a shared static-literal key; emit edges dispatcher → each handler, tagged
      `synthesizedBy: 'event-channel'`. → verify: scenarios "Event handler is reachable", "Mismatched
      channel keys produce no edge".
- [ ] Enforce the fan-out cap (default 8); drop + log over-cap channels. → verify: "Over-cap channel
      is dropped, not guessed".

## 4. Route → handler rule
- [ ] Wire each route detected by route inventory to its bound handler as a `calls`-kind edge tagged
      `synthesizedBy: 'route-handler'`. → verify: "Route is wired to its handler".

## 5. Reachability & traversal provenance
- [ ] In `reachability.ts`, exclude synthesized-only-reachable nodes from `high`-confidence dead
      (reclassify reachable or downgrade to `low` with rule-named reason). → verify:
      "Callback-only-reachable symbol is not high-confidence dead"; retire the matching false-positive
      called out in the `reachability.ts` header.
- [ ] Add a directly-resolved-only traversal option to reachability, `analyze_impact`, `select_tests`,
      `get_subgraph`, `find_path`; default includes synthesized edges. → verify: "Strict mode excludes
      synthesized edges".

## 6. Regression & docs
- [ ] Run the analyzer + mcp-handlers suites: `npx vitest run src examples`.
- [ ] Update the `reachability.ts` HONEST LIMITS comment to note that callback/event/route dispatch is
      now partially recovered (single-language, statically-paired) and which limits remain (reflection,
      computed dispatch, cross-language).

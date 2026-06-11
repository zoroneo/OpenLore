# analyzer spec delta

## ADDED Requirements

### Requirement: SynthesizedDynamicDispatchEdges

The system SHALL augment the directly-resolved call graph with a deterministic synthesis pass that
adds call edges for dynamic-dispatch patterns that direct name resolution cannot recover, deriving
each edge from statically-paired sites in the AST. The pass SHALL NOT use an LLM, SHALL run after
direct resolution, and SHALL only add edges — it SHALL NOT modify or remove any directly-resolved
edge. At minimum the pass SHALL recover:

- **Event channels** — an edge from a dispatch site (`emit(k)` / `dispatch(k)`) to every handler
  registered on the same channel key `k` (`on(k, fn)` / `addEventListener(k, fn)`), when the key is a
  static key (string literal, substitution-free template, or constant member reference) shared by
  both sites. Event-channel recovery is **per-language**: it applies to each language whose
  registration and dispatch sites are both statically visible, starting with JavaScript/TypeScript
  and extending to further languages one at a time (see `MultiLanguageEventChannelSynthesis`).
- **Route → handler** — an edge from a route node already detected by route inventory to the handler
  function the route binds.

The pass SHALL be structured as independent per-pattern rules so that each rule is testable in
isolation and adding a rule does not alter the output of existing rules.

#### Scenario: Event handler is reachable through a synthesized edge

- **GIVEN** a handler function registered with `on('mount', handler)` and a separate site calling
  `emit('mount')`, with no direct call to `handler`
- **WHEN** the call graph is built
- **THEN** a synthesized edge exists from the `emit('mount')` site's enclosing function to `handler`

#### Scenario: Route is wired to its handler

- **GIVEN** a route that route inventory detects and the handler function it binds
- **WHEN** the call graph is built
- **THEN** a synthesized `calls`-kind edge exists from the route node to the handler function

#### Scenario: Mismatched channel keys produce no edge

- **GIVEN** a handler registered with `on('open', handler)` and a dispatch site calling `emit('close')`
- **WHEN** the call graph is built
- **THEN** no synthesized edge is created between the dispatch site and `handler`

#### Scenario: Direct edges are unchanged by synthesis

- **GIVEN** a call graph built with the synthesis pass enabled and the same graph built with it disabled
- **WHEN** the two graphs are compared
- **THEN** every directly-resolved edge is identical in both, and the synthesis-enabled graph differs
  only by added edges

### Requirement: MultiLanguageEventChannelSynthesis

The system SHALL recover event-channel edges across the languages it parses, not only
JavaScript/TypeScript, applying the same high-precision discipline per language: an edge is emitted
only when a registration site (`on`/`once`/`addListener`/`subscribe`/… with a static key and a
resolvable handler) and a dispatch site (`emit`/`dispatch`/`publish`/… on the same static key) are
both statically visible in that language. Each language's collector resolves the channel key and the
handler from that language's own AST; the pairing, fan-out cap, and provenance labeling are shared
and language-agnostic. Adding a language SHALL NOT change the edges synthesized for any other
language, and a language whose idioms are not statically pairable SHALL emit no edges rather than
guess.

Languages are added one at a time. The set in effect is JavaScript/TypeScript, Python, Ruby, PHP, and
Swift (NotificationCenter `addObserver(forName:)` ↔ `post(name:)`); the handler may be a function
reference, a member/attribute reference (`self.handler`), a bound reference, a Ruby block, a PHP
callable (`'fn'` / `[$this, 'm']`), or an inline function/lambda/closure (wired to the internal
functions its body calls). Keys are namespaced by kind (string / symbol / constant) so a key of one
kind never pairs with a same-text key of another.

#### Scenario: Python event handler is reachable through a synthesized edge

- **GIVEN** a Python handler registered with `emitter.on('mount', handler)` and a separate site
  calling `emitter.emit('mount')`, with no direct call to `handler`
- **WHEN** the call graph is built
- **THEN** a synthesized event-channel edge exists from the `emit('mount')` site's enclosing function
  to `handler`

#### Scenario: Python dispatch with a mismatched key produces no edge

- **GIVEN** a Python handler registered on `'open'` and a dispatch site on `'close'`
- **WHEN** the call graph is built
- **THEN** no synthesized edge is created between them

#### Scenario: Adding a language leaves other languages' edges unchanged

- **GIVEN** a project mixing JavaScript/TypeScript and Python event channels
- **WHEN** the call graph is built
- **THEN** the JavaScript/TypeScript synthesized edges are identical to those produced when no Python
  source is present, and the Python edges are added independently

### Requirement: TypeBasedEventSynthesis

The system SHALL recover **type-based** event edges in languages whose event systems key on an event
**type** rather than a string channel: a handler is registered by an annotation or a typed interface,
and a dispatch carries a constructed event instance. An edge SHALL be emitted from a dispatch site to
a handler when the handler's event type and the dispatched event's constructed type match, derived
statically from the AST with no LLM. The key is the event type name; pairing, the fan-out cap, and
provenance are shared with the string-key rule, but the producing rule is labeled distinctly
(`synthesizedBy: 'type-event'`). Type-based recovery is per-language and added one language at a time;
in effect it covers **Java** and **Kotlin** (Guava `@Subscribe` / Spring `@EventListener` handler methods paired with
`post(new T(...))` / `publishEvent(new T(...))`) and **C#** (a class implementing a handler interface
such as `INotificationHandler<T>` / `IRequestHandler<T>` paired with `Publish(new T(...))` /
`Send(new T(...))`). A dispatch whose argument is not a statically-typed construction SHALL emit no
edge rather than guess.

#### Scenario: Java annotated handler is reachable from its publisher

- **GIVEN** a method annotated `@Subscribe` (or `@EventListener`) whose first parameter type is `T`,
  and a separate site calling `post(new T(...))` (or `publishEvent(new T(...))`)
- **WHEN** the call graph is built
- **THEN** a synthesized `type-event` edge exists from the dispatch site's enclosing method to the
  annotated handler method

#### Scenario: C# typed handler is reachable from its publisher

- **GIVEN** a class implementing `INotificationHandler<T>` whose handler method takes `T`, and a
  separate site calling `Publish(new T(...))` (or `Send(new T(...))`)
- **WHEN** the call graph is built
- **THEN** a synthesized `type-event` edge exists from the dispatch site's enclosing method to the
  handler method

#### Scenario: Mismatched event types produce no edge

- **GIVEN** a handler for type `A` and a dispatch constructing type `B`
- **WHEN** the call graph is built
- **THEN** no synthesized edge is created between them

### Requirement: CallbackRegistrationSynthesis

The system SHALL recover edges for handlers that are **registered as callbacks** with a framework or
runtime that later invokes them, where there is no in-code dispatch site to pair against. When a
**named internal function** is passed as an argument to a **curated registrar** (an API known to
invoke its callback), the system SHALL add an edge from the registration site's enclosing function to
that handler, labeled `synthesizedBy: 'callback-registration'`. Only curated registrars SHALL match,
so a function passed to an unrelated call is never treated as a callback; and inline function/closure
arguments SHALL NOT be matched here (their bodies are already attributed to the enclosing function by
direct resolution, so an edge would be redundant). Recovery is per-language; in effect it covers
**Go** (`net/http` `HandleFunc`/`Handle` and router verbs `GET`/`POST`/… of gin/echo/chi) and
**JavaScript/TypeScript** (scheduler registrars `setTimeout`/`setInterval`/`setImmediate`/
`queueMicrotask`/`requestAnimationFrame`/`requestIdleCallback`/`nextTick`).

#### Scenario: Go HTTP handler registered by name is reachable

- **GIVEN** a function `handleX` passed to `mux.HandleFunc("/x", handleX)` (or `http.HandleFunc`, or a
  router `GET("/x", handleX)`), with no direct call to `handleX`
- **WHEN** the call graph is built
- **THEN** a synthesized `callback-registration` edge exists from the registration's enclosing
  function to `handleX`

#### Scenario: JS/TS scheduler callback registered by name is reachable

- **GIVEN** a named function `tick` passed to `setTimeout(tick, 1000)` (or `setInterval`), with no
  direct call to `tick`
- **WHEN** the call graph is built
- **THEN** a synthesized `callback-registration` edge exists from the enclosing function to `tick`

#### Scenario: A function passed to a non-registrar is not treated as a callback

- **GIVEN** a named function passed as an argument to a call whose method is not a curated registrar
- **WHEN** the call graph is built
- **THEN** no `callback-registration` edge is synthesized for it

### Requirement: EdgeProvenanceLabeling

The system SHALL label every synthesized edge with a provenance distinct from directly-resolved
edges, by setting its `confidence` to `synthesized` and recording the rule that produced it in an
optional `synthesizedBy` property naming the pattern (for example `event-channel`, `route-handler`,
`callback-arg`). Directly-resolved edges SHALL retain their existing `confidence` value and SHALL NOT
carry `synthesizedBy`. A serialized call graph that predates this property SHALL load unchanged, with
absent `synthesizedBy` treated as a directly-resolved edge.

#### Scenario: Synthesized edge carries provenance

- **GIVEN** a synthesized event-channel edge
- **WHEN** the edge is inspected
- **THEN** its `confidence` is `synthesized` and its `synthesizedBy` names the producing rule

#### Scenario: Directly-resolved edge is distinguishable

- **GIVEN** a directly-resolved import edge
- **WHEN** the edge is inspected
- **THEN** its `confidence` is its resolution method (not `synthesized`) and it has no `synthesizedBy`

#### Scenario: Synthesized edges cost more in call distance

- **GIVEN** two paths from A to B, one entirely directly-resolved and one that traverses a synthesized edge
- **WHEN** call distance is computed for each path
- **THEN** the path traversing the synthesized edge has the greater total cost

### Requirement: HighPrecisionSynthesisBounds

The system SHALL bias edge synthesis toward false-negatives over false-positives: it SHALL emit an
edge only when a registration site and a dispatch site are statically paired on a shared key or
binding, and SHALL NOT fan a dispatch site out to functions it cannot pair. Per-channel handler
fan-out SHALL be capped by a fixed bound (default 8); a channel whose registered-handler count
exceeds the bound SHALL be dropped (no edges emitted for it) rather than partially or speculatively
wired, and the drop SHALL be logged with the channel key and count.

#### Scenario: Unpaired dispatch emits nothing

- **GIVEN** a dispatch site `emit('change')` with no statically-visible registration on `'change'`
- **WHEN** the synthesis pass runs
- **THEN** no synthesized edge is emitted for that dispatch site

#### Scenario: Over-cap channel is dropped, not guessed

- **GIVEN** a channel key with more registered handlers than the fan-out cap
- **WHEN** the synthesis pass runs
- **THEN** no synthesized edges are emitted for that channel and the drop is logged with the key and count

### Requirement: ProvenanceAwareReachability

The system SHALL prevent synthesized edges from manufacturing false dead-code positives while still
benefiting from them: a symbol reachable from a root only through one or more synthesized edges SHALL
NOT be reported as `high`-confidence dead by dead-code analysis. Such a symbol SHALL be reclassified
as reachable, or at minimum reported at `low` confidence with a reason that names the synthesizing
rule. A symbol reachable through at least one fully directly-resolved path is unaffected.

The system SHALL include synthesized edges by default when computing reachability, impact, subgraphs,
and paths, and SHALL provide an option to restrict traversal to directly-resolved edges only, so a
caller can trade completeness for certainty.

#### Scenario: Callback-only-reachable symbol is not high-confidence dead

- **GIVEN** a function reachable from an entry point only through a synthesized event-channel edge
- **WHEN** dead-code analysis runs
- **THEN** the function is not reported as `high`-confidence dead, and if reported at all it is `low`
  confidence with a reason naming the synthesizing rule

#### Scenario: Strict mode excludes synthesized edges

- **GIVEN** a traversal requested in directly-resolved-only mode
- **WHEN** reachability is computed
- **THEN** synthesized edges are not traversed and a symbol reachable only through them is treated as
  unreached

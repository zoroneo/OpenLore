# Tasks — Type-hierarchy-resolved polymorphic dispatch with provenance

> Status: DONE (PR #155). Implemented in `src/core/analyzer/cha.ts` (build Pass 7b), with the
> legacy cross-product removed from `graph.ts`. Decision recorded: `f1ab7353`.
> Call `record_decision` before writing code for step 2 (it adds a synthesis rule and a new edge-kind
> usage to the core call graph) and step 4 (it removes the legacy inheritance adjacency expansion — a
> change to a load-bearing data path). Both reuse existing types, so neither adds a new data
> structure, but both change graph semantics enough to record.
>
> **Implementation notes / corrections to the draft assumptions:**
> - §1 was *not* fully type-free: `kind: 'overrides'` existed only on `InheritanceEdge.kind`, not on
>   `CallEdge`'s `EdgeKind` union — so materializing override edges as `CallEdge`s required adding the
>   single member `'overrides'` to `EdgeKind`. No new `EdgeConfidence` and no new `CALL_DISTANCE_COSTS`
>   arm (both reuse `'synthesized'`, cost 4); the `callDistance` exhaustiveness test is untouched.
> - The CHA pass also EXCLUDES synthetic module groupings (`ClassNode.isModule`) from the hierarchy: a
>   free function is not a polymorphic method, so resolving `redis_client.get()` against a module-level
>   `get()` would manufacture a false edge. (Caught by an existing test on first run.)
> - `bfsFromDB`/`buildWeightedAdjacency` did *no* inheritance expansion before, so `analyze_impact`/
>   `get_subgraph` actually GAIN override propagation now that edges are materialized into the store.
> - Override edges anchor only to *concrete* method declarations: a body-less abstract/interface base
>   method (e.g. TS `abstract area();`) is not extracted as a node, so no override edge forms from it —
>   a node-extraction boundary (same class as the deferred `widen-js-function-node-extraction`),
>   honest under the false-negative bias. Concrete-to-concrete overrides (e.g. `Circle.area →
>   Annulus.area`) are captured.
>
> **Verification:** 23 new tests (`cha.test.ts`, `reachability-cha.test.ts`, `graph.test.ts` additions);
> full suite green (3747). E2e through the compiled CLI on a real `Shape` hierarchy (override +
> cha-name-arity virtual-dispatch persisted with provenance; `find_dead_code` reports the impls
> `low`-confidence by default and `high` under `directResolvedOnly` — the ProvenanceAwareReachability
> guarantee) and on OpenLore's own `src` (~3,900 fns): 501 `cha-name-arity` edges, **82% resolving to a
> unique target**, fan-out ≤ 6, no crash, no false hubs (synthesized edges excluded from structural
> metrics). All five requirements folded into the canonical `openspec/specs/analyzer/spec.md`
> (`ProvenanceAwareReachability` replaced with the MODIFIED version); this change is archived.
>
> **Real-OO-corpus adversarial dogfood (follow-up, same PR #155).** The initial dogfood used a
> synthetic Shape fixture + OpenLore's own (functional) src, which produced ZERO override and ZERO
> `cha-declared-type` edges. A second pass on real inheritance-heavy repos — **java-design-patterns**
> (GoF patterns), **python-patterns**, and a **dotnet/samples** C# slice — exercised all three edge
> types and surfaced (and fixed) three real defects:
> - **Cross-file same-name class collision → false override edge.** `buildClassNodes` resolved a base
>   class NAME globally (first-match-wins), so `proxy.py::Proxy(Subject)` linked to an unrelated
>   `observer.py::Subject`, synthesizing a false `Subject.__init__ → Proxy.__init__` override. Fixed:
>   resolve a base/interface name to a **same-file** class before any global match (a class extending
>   a base whose name also names an unrelated class elsewhere now links to the local declaration).
>   Residual: an *empty* same-file base (no methods → not a ClassNode) still falls back to global —
>   rare, documented.
> - **`var x = new T()` declared type never recovered (Java/C#).** The type-inference engine required
>   an uppercase declared type, so Java 10+/C# `var` locals recovered nothing and every virtual call
>   fell to the broad `cha-name-arity` over-approximation, leaking across packages on method-name
>   collisions (`Mammoth.timePasses` ↔ `Weather.timePasses`). Fixed: recover `var x = new T()`. Effect
>   is even better than narrowing CHA — the call now resolves DIRECTLY (`type_inference`) in Pass 2, so
>   CHA dedups it entirely (Java `cha-name-arity` 113→65, the cross-dir leaks gone, edges now precise
>   direct edges). Added a C# inference function too.
> - **CHA was inert for C#.** `extractClassRelationships` had no C# branch, so C# classes had empty
>   parent/interface sets and zero inheritance edges. Fixed: added a C# branch over the `base_list`
>   node (class/interface/record/struct), splitting base-class vs interface by the `I<Upper>`
>   convention. C# went 0 → 81 inheritance edges / 59 override edges on the slice.
>
> **Residual (spec-sanctioned, documented):** `cha-name-arity` still over-approximates for a receiver
> whose type is not locally recoverable — notably a **field** of a library generic type
> (`private List<X> observers; observers.add(o)` matched a user `LetterComposite.add`). Field-type
> tracking and RTA/VTA pruning are explicitly Out-of-scope (`HighPrecisionCHABounds`): the edge is
> labeled with the weakest provenance, bounded by the fan-out cap, excluded from structural metrics,
> and `directResolvedOnly`-excludable. Also: call-site arity is not extracted from raw edges, so the
> dispatch path matches by name only (arity is enforced on the override path). Tests: +7
> (`type-inference-engine.test.ts` Java/C# `var new T`; `cha.test.ts` cross-file resolution + C#
> override edges). Full suite green (3754).
>
> **Multi-language coverage + dogfood pass (follow-up, same PR #155).** Auditing
> `extractClassRelationships` against the languages OpenLore parses revealed CHA was **inert for
> Kotlin, PHP, Swift, and Scala** — they extract classes but had no hierarchy-extraction branch (the
> exact C# defect, ×4: zero inheritance edges → zero override/dispatch edges). Added a branch for each
> (Kotlin/Swift via delegation/inheritance specifiers, PHP splitting `base_clause` vs
> `class_interface_clause`, Scala via `extends_clause` + a new `getScalaParser`). Ruby and Go already
> worked; C++ has a branch (its abstract-pure-virtual-base case is the documented node boundary).
> Real-repo dogfood (DesignPatternsPHP, kotlinx.coroutines) confirmed correct edges at scale (PHP 71,
> Kotlin 157 override edges) **and** surfaced two false-positive bugs, both fixed:
> - **Cross-file / cross-namespace same-name collision → false override edge.** Two unrelated `Logger`
>   (and `Formatter`) interfaces in different PHP namespaces: the child's implementers live in other
>   files, so same-file-first missed and the global first-match wired the wrong twin (and *stole* the
>   real edge). Fixed language-agnostically in `buildClassNodes`: when a base name is not same-file
>   AND is ambiguous (several classes share it across files), **skip** rather than guess —
>   false-negatives over false-positives. (Cost: some legitimate reused-name cross-file edges are also
>   skipped; namespace/FQCN-aware resolution is the future enhancement, like RTA/VTA pruning.)
> - **Kotlin qualified supertype mis-captured.** `interface Job : CoroutineContext.Element` matched the
>   outer segment `CoroutineContext` (a phantom class from extension-function receivers `fun
>   CoroutineContext.x()`), synthesizing false `CoroutineContext.x → Job.x` overrides. Fixed by taking
>   the supertype's leaf name and **skipping qualified types** (`Outer.Inner`); applied to Swift too
>   (identical `user_type` structure, same latent bug). Generic supertypes (`Segment<T>`) still
>   resolve correctly to `Segment`.
>
> Also verified the last unproven scenario end-to-end: **override propagation through the DB-backed
> lazy path** — a `bfsFromDB` test (real `EdgeStore`) confirms override edges are traversed by default
> and excluded under `directResolvedOnly`, matching the in-memory `buildAdjacency` path. Tests: +8
> (`cha.test.ts` Kotlin/PHP/Swift/Scala override + ambiguous-cross-file + Kotlin-qualified-supertype;
> `graph.test.ts` bfsFromDB DB-path propagation). Full suite green (3762). Languages with CHA hierarchy
> support: TS/JS, Python, Java, C++, C#, Ruby, Go, Kotlin, PHP, Swift, Scala.
>
> **Layered base resolution — recall recovery (follow-up, same PR #155).** Measuring the previous
> ambiguity-skip on real repos showed it was far too conservative: it dropped a cross-file override
> edge whenever the base class name was reused ANYWHERE — **~37% of all base-references on Laravel
> (1,034 of 2,810)**. Replaced the bare same-file-then-skip logic in `buildClassNodes` with layered,
> most-specific-evidence-first resolution: **(1)** same file → **(2)** the file the child imports the
> name from (`importMap`, now threaded in — covers Java/TS/JS/Python/Go/Rust/Ruby) → **(3)** unique
> within the child's directory (same package) → **(4)** globally unique → **(5)** skip (genuinely
> ambiguous across directories with no import). Layers 1–4 each carry real evidence; only truly
> unresolvable bases are skipped, preserving the false-negative-over-false-positive bias.
> Dogfooded:
> - **DesignPatternsPHP** 71 → 87 override edges: recovered the real `FactoryMethod/Logger`,
>   `StaticFactory/Formatter`, and `Bridge/Formatter` hierarchies the skip had dropped — each
>   implementer now resolves to its OWN directory's base — while the cross-namespace false edges stay
>   gone, and ZERO cross-top-directory edges remain.
> - **Laravel** (1,640 files): 1,758 override edges, 512 cross-package. An adversarial agent audit of
>   the riskiest reused names (`Builder`/`Grammar`/`Connection`/`Driver`/`Guard`/`Loader`/… incl. all
>   6 genuinely globally-ambiguous base names) found **zero false positives** — import resolves the
>   cross-package `Contracts/*` bases, directory-locality resolves same-namespace siblings (Query vs
>   Schema `Builder`/`Grammar`), never cross-wiring. Precision held at ~100% with a large recall gain.
>
> Residual: a globally-duplicated base name that is neither same-dir-unique NOR import-disambiguated is
> still skipped (rare; e.g. a non-importMap language using cross-namespace inheritance without same-dir
> co-location). Tests: +1 (`cha.test.ts` directory-locality recovery resolves to the correct twin).
> Full suite green (3763).
>
> **Go/Ruby/C++ real-repo dogfood (follow-up, same PR #155).** The languages whose CHA had only ever
> been exercised on synthetic fixtures (Go embedding, Ruby modules, C++ multiple/virtual inheritance)
> were dogfooded on real repos (cobra, jekyll, RefactoringGuru/design-patterns-cpp) via adversarial
> agents. One tractable false-positive bug found and fixed; the rest characterized as known limits:
> - **FIXED — Go named-field misread as an embed.** The embedding query captured the *type* of every
>   struct field, so a NAMED field (`CompletionOptions CompletionOptions` in cobra) became a phantom
>   `embeds` edge and polluted `parent_classes` with field types (`string`/`bool`/…). Now captures the
>   `field_declaration` and treats it as an embed only when it has no `name:` field; also unwraps
>   pointer embeds (`*Mixin`), which the bare-`type_identifier` query had MISSED. Verified on cobra
>   (phantom edge 1→0, `Command.parentClasses` `[]`) and a synthetic struct (anonymous + pointer embeds
>   wire, named field excluded, override `Base.Speak→Derived.Speak` forms). +1 test.
> - **C++ (known limit, abstract-base boundary).** A pure-virtual-only base (`class Subject { virtual
>   void f()=0; };`) has no body-bearing method, so it is not extracted as a node; in the patterns repo
>   (many independent programs each redefining `Subject`/`Component`) the layered resolver's
>   global-unique fallback then bound a derived class to a same-named base in another program's file.
>   In real cohesive C++ this surfaces as a missing edge (the documented abstract-base node boundary),
>   not a false edge; the sound fix is abstract/interface-method node extraction (a cross-cutting
>   change, deferred — same class as `widen-js-function-node-extraction`). C++ multiple inheritance was
>   verified CORRECT (both bases captured).
> - **Ruby (known limit, latent).** Two same-name classes in different modules (`Kramdown::Parser::
>   SmartyPants` vs `Jekyll::Converters::SmartyPants`) merge into one ClassNode because grouping keys on
>   the bare class name; no false edge resulted here (arity-matched by luck). Module-qualified class
>   identity is the fix (Ruby-extractor change, deferred). All 14 jekyll override edges were correct.
> - **Go interface-satisfaction (coverage gap, separate work).** Go's primary polymorphism is
>   structural interface satisfaction (a type satisfies an interface by having its method set, no
>   `implements` keyword); the hierarchy extractor handles only embedding, so Go override edges are
>   limited. Recovering this needs structural method-set matching — a distinct mechanism, future work.
> - **cha-name-arity ubiquitous-name volume (spec-sanctioned).** On jekyll, `to_s` alone produced ~33%
>   of the 977 cha-name-arity edges, fanning across unrelated classes (receiver type unrecoverable).
>   This is the documented over-approximation; `HighPrecisionCHABounds` explicitly forbids a method-name
>   denylist, so the fan-out cap remains the bound and these edges keep the weakest provenance label.
> Tests: +1 (`cha.test.ts` Go embedding). Full suite green (3764). CHA hierarchy support across TS/JS,
> Python, Java, C++, C#, Ruby, Go, Kotlin, PHP, Swift, Scala has now been real-repo-dogfooded.

## 1. Confirm the surface is purely additive (no type changes)
- [x] Verify `EdgeConfidence` already includes `'synthesized'` (`call-graph.ts:34`), `CallEdge` already
      has `synthesizedBy?` and `kind?`, and `kind: 'overrides'` is in the `EdgeKind` union
      (`call-graph.ts:275`). → verify: no new type members are needed; the `callDistance`
      exhaustiveness test (`call-graph.test.ts`) requires no change.
- [x] Confirm graph serialization round-trips `calls` edges with `synthesizedBy: 'cha-*'` and
      `overrides` edges with `synthesizedBy: 'override'`, and that a pre-existing serialized graph
      lacking them loads unchanged.

## 2. CHA virtual-dispatch rule
- [x] Add a `cha-dispatch` rule to the existing per-rule synthesis pass
      (`synthesizeDynamicDispatchEdges`, `call-graph.ts:2998`), ordered to run **after**
      `buildClassNodes` (`call-graph.ts:2493`) so `ClassNode` / `InheritanceEdge` are available
      (move CHA to a Pass 2e if Pass 2d runs before class building). The rule resolves an unpinned
      `recv.m(args)` to method implementations in `recv`'s type subtree. → verify: scenarios "Virtual
      call resolves to all overrides in the receiver's subtree", "Unrelated method names produce no
      edge", "Calls on external types do not resolve".
- [x] Recover the receiver's declared type via annotation / `new T()` / parameter type / the existing
      `inferTypesFromSource` + `resolveViaTypeInference` (`type-inference-engine.ts:20,141`); when
      recovered, restrict targets to `T`'s subtree and tag `synthesizedBy: 'cha-declared-type'`;
      otherwise target name+arity matches over the hierarchy and tag `synthesizedBy: 'cha-name-arity'`.
      → verify: scenarios "Declared receiver type narrows the target set", "Precise and
      over-approximating dispatch are distinguishable".
- [x] Enforce the per-call-site fan-out cap (default 8, the dynamic-dispatch bound); drop + log
      over-cap call sites with method name and candidate count. → verify: "Ubiquitous method name
      exceeding the cap is dropped, not guessed", "Unresolvable method emits nothing".

## 3. Method-level override rule
- [x] Add an `override` rule that emits `B.m → D.m` (`kind: 'overrides'`,
      `synthesizedBy: 'override'`) for each name-and-arity-matched override where `D <: B` in the
      hierarchy. → verify: "Override edge connects matching methods only", "No silent drop on large
      class pairs".
- [x] Confirm the directly-resolved graph is byte-identical with the CHA pass disabled (additive
      only). → verify: "Direct edges are unchanged by CHA synthesis".

## 4. Retire the legacy inheritance cross-product; unify the paths
- [x] Remove the class-level all-parent-methods → all-child-methods expansion from `buildAdjacency`
      (`graph.ts:79-96`), including its silent `>200` drop. Materialized override edges now carry
      inheritance propagation. → verify: in-memory and DB-backed paths agree ("Override propagation
      is consistent across reachability paths").
- [x] Confirm `bfsFromDB` (`graph.ts:128`) traverses the materialized `overrides` edges through its
      existing edge-store reads (no special-casing) and that `buildWeightedAdjacency`'s existing
      `kind !== 'calls'` filter (`graph.ts:187`) keeps `overrides` edges out of call-distance.
      → verify: "Override edges do not contribute to call distance".
- [x] Confirm `directResolvedOnly` already excludes the new edges in both `buildAdjacency`
      (`graph.ts:71`) and `bfsFromDB` (`graph.ts:148-152`) because they are `confidence: 'synthesized'`.
      → verify: "Strict mode excludes CHA edges in every reachability path".

## 5. Reachability, impact & test-selection provenance
- [x] Extend the existing synthesized-only downgrade in `reachability.ts` so a symbol reached only via
      `cha-name-arity` or `override` edges is not `high`-confidence dead (reclassify or downgrade to
      `low` with the rule named). → verify: "Override-only-reachable symbol is not high-confidence
      dead", "Polymorphic-call-only-reachable symbol is not high-confidence dead".
- [x] Confirm `analyze_impact`, `select_tests`, `get_subgraph`, `find_path`, and
      `trace_execution_path` include the new edges by default and exclude them under
      `directResolvedOnly` (already threaded for dynamic-dispatch edges). → verify: "Test selection
      follows a base-method change to subtype tests".

## 6. Regression, anti-regression & docs
- [x] Audit existing tests that depended on the old N×M cross-product behavior (search adjacency /
      inheritance reachability tests); update assertions to the precise override-edge behavior and
      add a regression test that the previously-dropped large-class-pair case now emits edges.
- [x] Run the analyzer + mcp-handlers suites: `npx vitest run src examples`. Mirror CI (note: `test/`
      is gitignored and excluded from CI — keep CI-protected guards in plain `*.test.ts` under `src`).
- [x] Update the `reachability.ts` HONEST LIMITS comment: polymorphic dispatch through
      inheritance/interfaces is now recovered (single-language, name+arity, declared-type-narrowed
      where possible); remaining limits are reflection/computed dispatch, cross-language polymorphism,
      and RTA/VTA-level pruning of the name-arity over-approximation.
- [x] Verify end-to-end through the compiled CLI on a really-analyzed repo (the dynamic-dispatch
      change's verification method): build, analyze a repo with a real class hierarchy, and confirm
      `analyze_impact` / `find_dead_code` / `select_tests` reflect the override and virtual-dispatch
      edges and that strict mode excludes them.

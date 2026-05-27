# OpenLore Spec 07 — Infrastructure-as-Code Languages (Terraform/HCL, Pulumi, CloudFormation, Ansible, Kubernetes, Helm)

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Context for you (the agent)

OpenLore is graph-native: it models a codebase as functions (nodes) and calls (edges), then serves orientation questions over that graph — `orient`, `search_code`, `get_subgraph`, `analyze_impact`, `trace_execution_path`. Today it understands general-purpose languages (TypeScript, JavaScript, Python, Go, Rust, Ruby, Java, C++, Swift) via tree-sitter.

The next frontier is **Infrastructure-as-Code**. IaC is where "who references this?" and "what is the blast radius of changing this?" are the highest-value questions an agent can answer — and where existing single-language tools are weakest. If you change a security group, a subnet, a ConfigMap, an IAM role, or a Helm value, *what breaks?* That is exactly a graph reachability query, and OpenLore already has the engine for it. This spec extends OpenLore's ingestion to the dominant IaC ecosystems so that infrastructure shows up in the same graph as application code.

### The core insight — IaC maps cleanly onto the existing graph

IaC is not call-graph-shaped (resources do not "call" each other), but it **is** dependency-graph-shaped, and OpenLore's node/edge model already expresses dependency graphs. The mapping:

| IaC concept | OpenLore graph primitive |
|---|---|
| A resource / manifest object / play / stack resource | a node (reuse `FunctionNode`) |
| A reference between resources (interpolation, `Ref`, selector, `notify`, `depends_on`) | an edge (reuse `CallEdge`), **dependent → dependency** |
| A module / chart / role / nested stack | a grouping (reuse `ClassNode`, like a module node) |
| A provider / registry module / base image / external chart | an external node (`isExternal: true`) |
| A variable / output / parameter / value | a node, so references resolve through it |

Because we reuse the existing primitives, **`orient`, `search_code`, `get_subgraph`, `analyze_impact`, the SCIP export (spec-04), and the federation manifest (spec-05) all work on infrastructure with zero changes to MCP tools, the graph schema, or `orient`.** Edge direction is **dependent → dependency**, so depth-1 `callers` of a node answers "who depends on this?" (blast radius) and `fanOut` answers "what does this resource need?" — the two questions operators actually ask.

This is the decision to record before writing code (see `record_decision`): *IaC is ingested by projecting a normalized resource graph onto the existing `FunctionNode`/`CallEdge`/`ClassNode` primitives; no graph-schema or MCP-tool changes.*

## Scope contract — do not break these things

This PR must NOT:

- Change the `FunctionNode` / `CallEdge` / `ClassNode` schema, the MCP tools, or `orient`. IaC must ride on the existing primitives.
- Regress any existing language. The general-purpose extractors and all current tests stay green and byte-identical in output where unchanged.
- Attempt to *evaluate* IaC (no `terraform plan`, no Helm render, no Ansible run, no cloud API calls). This is **static** analysis only: parse files, extract declared resources and references.
- Require any external CLI (`terraform`, `helm`, `kubectl`, `ansible`, `pulumi`, `aws`) at analyze time.
- Over-promise precision. IaC references are often dynamic (computed names, templated values, `for_each`). Extract the references you can resolve statically; for the rest, emit nothing rather than a wrong edge, and leave a `TODO(spec-07-followup): …`.

This PR must:

- Add ingestion for **all six** ecosystems below in **one PR**: Terraform/HCL, Kubernetes manifests, Helm charts, CloudFormation, Ansible, and Pulumi. (See the per-ecosystem priority ordering — Terraform is the deepest/required reference implementation; the others follow the same normalized model.)
- Make IaC files **discoverable**: scanned by the file walker, mapped to a language by `detectLanguage` (with content disambiguation for ambiguous `.yaml`/`.yml`/`.json`), parsed into nodes+edges, merged into the graph, and indexed for search.
- Be deterministic: re-analyzing an unchanged IaC tree produces an identical graph (stable node ids, sorted edges).
- Isolate IaC logic in `src/core/analyzer/iac/` so it is cleanly separable, mirroring how `src/core/scip/` is isolated.

## The normalized resource graph (the contract every ecosystem produces)

Each ecosystem parser produces a normalized intermediate, then a single projector maps it onto the graph:

```ts
interface IacResource {
  address: string;        // canonical, ecosystem-specific (e.g. "aws_s3_bucket.logs", "Deployment/web", "AWS::S3::Bucket:MyBucket")
  type: string;           // resource type / kind ("aws_s3_bucket", "Deployment", "AWS::S3::Bucket", role name)
  kind: 'resource' | 'data' | 'module' | 'variable' | 'output' | 'provider'
       | 'manifest' | 'play' | 'task' | 'role' | 'handler' | 'value' | 'stack';
  filePath: string;       // repo-relative, POSIX
  startLine: number;      // 1-based; REQUIRED (used for graph/SCIP ranges)
  endLine?: number;
  module?: string;        // owning module/chart/role/stack, for grouping
  isExternal?: boolean;   // provider, registry module, remote chart, base image
  signature: string;      // the declaration header, for search/signatures
}
interface IacReference {
  fromAddress: string;    // the dependent (it references…)
  toAddress: string;      // …the dependency
  kind: 'references' | 'depends_on';
  line?: number;
}
```

Projection onto the existing graph:
- `IacResource` → `FunctionNode` with `name = address`, `className = type`, `language = <ecosystem tag>`, `filePath`, `startLine`/`endLine`, `signature`, `isExternal`. (No new fields. `className` carries the type so clustering and `get_architecture_overview` group by resource type.)
- `IacReference` → `CallEdge` with `callerId = node(fromAddress)`, `calleeId = node(toAddress)`, `kind: 'references' | 'depends_on'`, a confidence value, resolved within and across files in the same project.
- `module` → `ClassNode` (module-style grouping; `methodIds` = member resources).
- Unresolved targets (computed/templated) → drop the edge (do not invent), or point to an `isExternal` node when the target is genuinely external (a provider/registry).

Language tags to add (used as `FunctionNode.language` and surfaced by spec-05's manifest `languages[]`): `Terraform`, `Kubernetes`, `Helm`, `CloudFormation`, `Ansible`, `Pulumi`. Note for spec-04 SCIP export: SCIP's `Language` enum has no Terraform/Helm/Ansible/CloudFormation value — these map to `UnspecifiedLanguage` (already handled by `scipLanguageName` returning `''`); `Kubernetes`/`Helm` content is YAML but keep the semantic tag. No spec-04 change required.

## Per-ecosystem deliverables

Implement in this order; Terraform is the reference the others copy.

### 1. Terraform / HCL  *(required, deepest)*

- **Files:** `*.tf`, `*.tf.json`, `*.tfvars`. **Parser:** add `tree-sitter-hcl` (consistent with the existing tree-sitter approach and gives line numbers) — or a pure-JS HCL parser if native build is undesirable; pin the choice in a comment and justify in the PR.
- **Nodes:** `resource "type" "name"`, `data "type" "name"`, `module "name"`, `variable "name"`, `output "name"`, `locals { … }` (each local), `provider "name"`.
- **Edges (references):** interpolation and bare references inside attribute values — `type.name.attr`, `var.x`, `local.y`, `module.m.out`, `data.t.n.attr` — plus explicit `depends_on = [...]`. Resolve each reference to its declared node within the project (module-aware).
- **Modules:** `module "m" { source = … }` → a `ClassNode`; `source` that is local (`./…`/`../…`) links to that module's resources; registry/git sources → an `isExternal` module node.
- **Providers** → `isExternal` nodes. **`count`/`for_each`** → a single node for the block (do not enumerate instances); note in `signature`.
- **Gotchas:** `${…}` legacy interpolation vs HCL2 bare refs; `terraform_remote_state` data sources (cross-stack — link to external); heredocs; JSON variant (`*.tf.json`).

### 2. Kubernetes manifests  *(required)*

- **Files:** `*.yaml`/`*.yml` that are K8s manifests (see disambiguation). Multi-document YAML (`---`) — one node per document. Use the existing `yaml` dependency.
- **Nodes:** one per object, `address = "<kind>/<metadata.name>"` (namespaced when present: `<ns>/<kind>/<name>`), `type = kind`, `module = namespace`.
- **Edges:** label selectors (`Service.spec.selector` → matching `Deployment`/`Pod` labels), `configMapKeyRef`/`secretKeyRef`/`envFrom`, volume `configMap`/`secret`/`persistentVolumeClaim` refs, `serviceName` (StatefulSet → Service), `ownerReferences`, `Ingress` → `Service` (`backend.service.name`), `ServiceAccount` refs, namespace membership.
- **Gotchas:** selector matching is by label set, not name — resolve by intersecting `selector` with object `labels` within the project; CRDs (unknown kinds) still become nodes (type = the CRD kind), just with fewer typed edges.

### 3. Helm charts  *(required)*

- **Files:** a chart = a directory with `Chart.yaml`. Parse `Chart.yaml` (name, version, `dependencies[]` → subcharts), `values.yaml`, and `templates/*.yaml` / `templates/*.tpl`.
- **Templating:** templates are Go-templated YAML (`{{ … }}`), not valid YAML as-is. Do a **tolerant pre-pass** that masks `{{ … }}` expressions (replace with a placeholder scalar) so the structure YAML-parses; never execute templates. Extract the rendered-shape resources best-effort.
- **Nodes:** the chart (`ClassNode`), each template-defined resource (like K8s), `values.yaml` keys referenced by templates (optional — high value but can be `TODO(spec-07-followup)`), named templates from `_helpers.tpl` (`define`).
- **Edges:** chart → subchart `dependencies` (subchart → `isExternal` if not vendored under `charts/`), `include`/`template` references to named templates, template → values references (`.Values.x`) when statically resolvable.
- **Gotchas:** aliased dependencies, `condition`/`tags`, library charts. Heavy templating → extract what parses; do not guess.

### 4. CloudFormation  *(required)*

- **Files:** `*.yaml`/`*.yml`/`*.json` that are CFN/SAM templates (disambiguation below). Supports YAML short-form intrinsics (`!Ref`, `!GetAtt`, `!Sub`).
- **Nodes:** `Resources.<LogicalId>` (`type = Type`, e.g. `AWS::S3::Bucket`), `Parameters`, `Outputs`, `Mappings`, `Conditions`.
- **Edges:** `Ref`, `Fn::GetAtt`, `Fn::Sub` `${…}` variable refs, `DependsOn` (→ `depends_on`), `Fn::ImportValue` (cross-stack → external), nested stacks (`AWS::CloudFormation::Stack` `TemplateURL`).
- **Gotchas:** YAML short-form tags need a CFN-aware YAML schema (custom tag handling on the `yaml` parser); SAM `Transform`; pseudo-parameters (`AWS::Region`, etc.) → external/builtin (ignore).

### 5. Ansible  *(required)*

- **Files:** playbooks (`*.yml`/`*.yaml` with `hosts:`/`tasks:`/`roles:`), roles (`roles/<name>/{tasks,handlers,defaults,vars,meta}/main.yml`), inventories.
- **Nodes:** plays, tasks (by `name`), handlers, roles, role vars/defaults.
- **Edges:** `notify` (task → handler), `include_tasks`/`import_tasks`/`include_role`/`import_role`/`import_playbook` (→ target), `roles:` list (play → role), role `meta/main.yml` `dependencies` (role → role), `vars`/`vars_files` references.
- **Gotchas:** Jinja2 `{{ }}` in values (tolerate like Helm); free-form module args; blocks/`rescue`/`always`; dynamic includes (drop unresolved).

### 6. Pulumi  *(required, lightest — a framework detector on existing languages)*

- Pulumi programs are written in TypeScript/Python/Go/C# — **already parsed** for the call graph. Do **not** add a new grammar. Add a **framework-detector** layer that recognizes Pulumi resource constructions and annotates them:
  - TS/JS: `new <pkg>.<Service>("name", { … })` (e.g. `new aws.s3.Bucket("logs", {…})`).
  - Python: `<pkg>.<Service>("name", …)` constructor calls.
- **Nodes:** each detected resource construction (`address = "<Service>:<name>"`, `language = 'Pulumi'`, `filePath`/`line` from the call site). **Edges:** when a resource's args reference another resource variable (`bucket.arn`), add a `references` edge.
- Scope conservatively: detect the common provider SDKs (`@pulumi/aws`, `@pulumi/gcp`, `@pulumi/azure-native`, `@pulumi/kubernetes`). Unknown SDKs → no resource nodes (the underlying functions still appear in the normal call graph). Note: CDK / CDKTF are structurally similar but **out of scope** (see below).

## Discovery: file walker, language detection, disambiguation

- **File walker** ([src/core/analyzer/file-walker.ts](../../src/core/analyzer/file-walker.ts)) is deny-list based, so `.tf`/`.yaml` files are already walked; confirm IaC extensions are not skipped (note: `pnpm-lock.yaml` and `*.rc.yaml` patterns are intentionally skipped — keep those).
- **`detectLanguage`** ([src/core/analyzer/signature-extractor.ts:39](../../src/core/analyzer/signature-extractor.ts#L39)) maps by extension today and returns `unknown` for `.tf`/`.yaml`, which drops the file. Extend it: `.tf`/`.tfvars`/`.tf.json` → `Terraform`. For `.yaml`/`.yml`/`.json`, the extension is ambiguous, so route through **content-based disambiguation**:
  - `apiVersion:` + `kind:` (and not a Helm template dir) → `Kubernetes`
  - `AWSTemplateFormatVersion`/`Transform: AWS::Serverless` or `Resources:` with `Type: AWS::…` → `CloudFormation`
  - under a chart (`Chart.yaml` present in an ancestor) or `templates/` with `{{ }}` → `Helm`
  - `hosts:`/`tasks:`/`roles:` at the top level, or located under `roles/*/tasks|handlers|meta/` → `Ansible`
  - otherwise → `unknown` (leave generic YAML config alone; do not force a classification).
  Make disambiguation a small, well-tested pure function (`classifyYaml(path, content): IacKind | null`).
- **Parser dispatch:** the call-graph builder dispatches per `language` to an extractor. Add IaC branches that delegate to `src/core/analyzer/iac/<ecosystem>.ts` returning the normalized resource graph; merge the projected nodes/edges/classes into the `SerializedCallGraph`. Keep `call-graph.ts` thin — put parsing in `iac/`.
- **Signatures/search:** emit `FileSignatureMap` entries for IaC files (resource headers as "signatures") so IaC is searchable via Stage-1 and BM25 even before graph edges resolve.

## Files you will create or modify (approximate)

```
src/core/analyzer/iac/
  index.ts                 # IacGraphBuilder: dispatch by language → normalized graph → project to nodes/edges
  types.ts                 # IacResource, IacReference, IacKind
  project.ts               # normalized graph → FunctionNode/CallEdge/ClassNode
  classify-yaml.ts         # classifyYaml(path, content) disambiguation
  terraform.ts             # HCL parser + resource/reference extraction
  kubernetes.ts            # K8s manifest extraction
  helm.ts                  # chart + tolerant-template extraction
  cloudformation.ts        # CFN/SAM extraction (YAML short-form + JSON)
  ansible.ts               # playbooks/roles/handlers extraction
  pulumi.ts                # framework detector over TS/Python/Go call graph
src/core/analyzer/signature-extractor.ts   # detectLanguage + IaC signatures
src/core/analyzer/call-graph.ts            # dispatch IaC languages to iac/ + merge
src/core/analyzer/file-walker.ts           # confirm IaC extensions scanned
package.json                               # tree-sitter-hcl (justify); yaml already present
docs/iac.md                                # what OpenLore extracts per ecosystem, limits
README.md                                  # "Languages" / add IaC support
test/  →  co-located *.test.ts + fixtures   # NOTE: top-level test/ is gitignored in this repo;
                                            #   co-locate tests next to source and put fixtures
                                            #   under src/core/analyzer/iac/fixtures/ (exclude from
                                            #   tsconfig + eslint, as done for src/core/scip/fixtures)
```

## Acceptance criteria

1. **Discovery:** `openlore analyze` on a repo containing each ecosystem produces graph nodes for that ecosystem (assert per-ecosystem node counts against fixtures). IaC files are no longer dropped as `unknown`.
2. **Terraform:** a fixture with `module → resource → resource` and `var`/`output`/`data` references yields the exact expected nodes and `references`/`depends_on` edges; `analyze_impact` on a base resource returns its dependents (blast radius). Lock exact counts.
3. **Kubernetes:** a `Service`/`Deployment`/`ConfigMap`/`Secret` fixture yields selector and `*KeyRef` edges; multi-doc YAML produces one node per doc.
4. **Helm:** a chart with a subchart dependency and a `_helpers.tpl` `define`/`include` yields chart→subchart and template→helper edges; templated values do not crash the parser.
5. **CloudFormation:** a template using `Ref`, `!GetAtt`, `DependsOn`, and a nested stack yields the corresponding edges; YAML short-form intrinsics parse.
6. **Ansible:** a playbook with `roles:`, `notify`→handler, and `include_tasks` yields play→role, task→handler, and include edges.
7. **Pulumi:** a TS (and a Python) program creating two resources where one references the other yields two `Pulumi` resource nodes and a `references` edge — without breaking the normal call graph for those files.
8. **Cross-cutting graph tools:** `orient`, `search_code`, and `get_subgraph` return IaC nodes/edges with no code changes to those tools (assert in an integration test on a mixed app+IaC fixture). The spec-05 manifest's `languages[]` includes the IaC tags; the spec-04 SCIP export emits IaC nodes (as `UnspecifiedLanguage` where applicable) without error.
9. **Determinism:** re-analyzing an unchanged IaC tree yields an identical graph (stable ids, sorted edges).
10. **No regression:** all existing tests pass; general-purpose language extraction is unchanged.
11. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass. If a new runtime dependency (`tree-sitter-hcl`) is added, the PR body justifies it (size, native-build status) exactly as spec-04 did for `protobufjs`.

## Detection heuristics — be conservative (read carefully)

- Resolve a reference to an edge **only** when the target node is unambiguous within the project. Computed names, `for_each` keys, fully-templated values, and dynamic includes → **no edge** (leave `TODO(spec-07-followup): dynamic reference resolution for <ecosystem>`).
- Unknown resource types/kinds (CRDs, custom providers) still become **nodes** (typed by their declared type) — just with fewer typed edges. Never drop a declared resource; only drop unresolved *edges*.
- Never classify generic YAML (CI configs, `docker-compose`, app config) as IaC. When `classifyYaml` is unsure, return `null` → `unknown` (unchanged behaviour).

## Out of scope for this PR (other languages / adjacent IaC)

All IaC ecosystems above ship in this one PR. The following are explicitly deferred to future specs to keep this bounded (do not start them here): **Bicep**, **ARM JSON templates**, **Kustomize** overlays, **Crossplane**, **CDK / CDKTF** (synthesize to CFN/TF; structurally similar to Pulumi but separate), **Dockerfile**, **docker-compose**, **Jsonnet/CUE**, **Nix**, **Bazel/Starlark**, **Packer**, **Vagrant**. Leave `TODO(spec-07-followup): <name>` references where a natural extension point exists. (You asked whether to fold another language family in — no: the six IaC ecosystems are a full PR on their own.)

## Test plan

- **Per-ecosystem unit tests**, co-located, using small fixtures under `src/core/analyzer/iac/fixtures/<ecosystem>/`. Build the normalized graph from each fixture, project it, and assert exact nodes + edges (lock counts once computed — small fixtures, like spec-04's tiny-repo).
- **`classify-yaml.test.ts`** — table-driven: each ecosystem's signature content classifies correctly; generic YAML (CI config, compose) classifies as `null`.
- **Mixed-repo integration test** — one fixture with app code + Terraform + a K8s manifest; assert `orient`/`get_subgraph` surface both app and infra nodes and an app→infra or infra→infra edge, proving the projection works through the existing tools unchanged.
- **Determinism test** — build twice, deep-equal the serialized graph.
- **Regression** — full existing suite stays green.

## Git workflow — read carefully

1. Branch: `openlore-spec-07-iac-languages` off the default branch.
2. **Open exactly ONE pull request** titled `spec-07: Infrastructure-as-Code language support` for **ALL** of this work — all six ecosystems, discovery, projection, docs, and tests. **Every commit for this spec — every ecosystem, every fix, every follow-up revision — pushes to that single PR. Never open a second PR under any circumstances.** If the design changes mid-flight, push more commits to the same branch. If a reviewer requests changes, push more commits to the same branch.
3. Land it incrementally **within that one PR**: a reasonable commit sequence is (a) normalized model + projection + `detectLanguage`/walker/`classifyYaml`, (b) Terraform, (c) Kubernetes, (d) Helm, (e) CloudFormation, (f) Ansible, (g) Pulumi, (h) docs + README + cross-cutting integration test. Each commit keeps `lint`/`typecheck`/`test:run`/`build` green.
4. Record the architectural decision (IaC projects onto existing graph primitives; no schema/MCP changes) via `record_decision` **before** writing code, per the repo's decision-gate workflow.
5. If an ecosystem's deep edge-resolution balloons scope, ship its **nodes** plus the edges you can resolve cleanly, and leave precise `TODO(spec-07-followup): …` markers — but still ship all six ecosystems' detection in this PR. Do not split ecosystems across PRs.
6. Run `lint`, `typecheck`, `test:run`, `build` before every push.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

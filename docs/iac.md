# Infrastructure-as-Code support

OpenLore models a codebase as a graph of nodes (functions/resources) and edges
(calls/references). Infrastructure-as-Code maps cleanly onto that same graph:
IaC is dependency-graph-shaped, and OpenLore already serves dependency queries.

Because IaC is **projected onto the existing graph primitives**
(`FunctionNode` / `CallEdge` / `ClassNode`), every graph tool works on
infrastructure with no changes: `orient`, `search_code`, `get_subgraph`,
`analyze_impact`, `trace_execution_path`, the SCIP export, and the federation
manifest.

## The mapping

| IaC concept | OpenLore graph primitive |
|---|---|
| A resource / manifest object / play / stack resource | a node (`FunctionNode`) |
| A reference (interpolation, `Ref`, selector, `notify`, `depends_on`) | an edge (`CallEdge`), **dependent → dependency** |
| A module / chart / role / stack | a grouping (`ClassNode`) |
| A provider / registry module / remote chart / base image | an external node (`isExternal`) |

Edge direction is **dependent → dependency**. So for any resource node:

- depth-1 **callers** = "who depends on this?" → **blast radius** (`analyze_impact`)
- **fanOut** = "what does this resource need?"

`FunctionNode.language` carries the ecosystem tag (`Terraform`, `Kubernetes`,
`Helm`, `CloudFormation`, `Ansible`, `Pulumi`); `className` carries the resource
type, so clustering and architecture overviews group by type.

## What is extracted, per ecosystem

This is **static** analysis only. OpenLore never runs `terraform plan`, renders
Helm, executes Ansible, or calls a cloud API. No external CLI is required.

### Terraform / HCL  (`*.tf`, `*.tfvars`, `*.tf.json`)
- **Nodes:** `resource`, `data`, `module`, `variable`, `output`, `locals` (each local), `provider` (external).
- **Edges:** interpolation and bare references (`type.name.attr`, `var.x`, `local.y`, `module.m.out`, `data.t.n.attr`) and explicit `depends_on`.
- **Modules:** local `source = "./…"` links the module to the resources declared under that directory; registry/git sources become external module nodes.
- **Notes:** parsed with a tolerant, hand-rolled HCL scanner (no native dependency). `count`/`for_each` produce a single node for the block (noted in the signature).

### Kubernetes  (`*.yaml`/`*.yml` manifests; multi-doc supported)
- **Nodes:** one per document, `address = <kind>/<name>` (namespaced as `<ns>/<kind>/<name>`).
- **Edges:** `Service` label selectors → matching workloads, `configMapKeyRef`/`secretKeyRef`/`envFrom`, volume refs, `StatefulSet.serviceName` → `Service`, `ownerReferences`, `Ingress` → `Service`, `serviceAccountName`.
- **CRDs:** unknown kinds still become nodes (typed by the CRD kind), just with fewer typed edges.

### Helm  (a directory containing `Chart.yaml`)
- **Nodes:** the chart (grouping), named templates (`define`), and best-effort template-defined resources (via a tolerant `{{ … }}` masking pre-pass — templates are never executed).
- **Edges:** chart → subchart dependencies (external unless vendored under `charts/`), and template → named-template (`include`/`template` → `define`).
- **Follow-up:** `.Values.x` → `values.yaml` key resolution (`TODO(spec-07-followup)`).

### CloudFormation / SAM  (`*.yaml`/`*.yml`/`*.json`)
- **Nodes:** `Resources.<LogicalId>` (typed by `Type`), `Parameters`, `Outputs`, `Mappings`, `Conditions`.
- **Edges:** `Ref`, `Fn::GetAtt`, `Fn::Sub` `${…}`, `DependsOn`, `Fn::ImportValue` (cross-stack → external), nested stacks (`AWS::CloudFormation::Stack` `TemplateURL` → external).
- **Notes:** YAML short-form intrinsics (`!Ref`, `!GetAtt`, `!Sub`, …) parse via a CFN-aware tag set. Pseudo-parameters (`AWS::Region`, …) are ignored.

### Ansible  (playbooks, `roles/<name>/{tasks,handlers,defaults,vars,meta}/main.yml`)
- **Nodes:** plays, named tasks, handlers, roles, role vars/defaults.
- **Edges:** `notify` (task → handler), `include_tasks`/`import_tasks`/`include_role`/`import_role`/`import_playbook`, `roles:` (play → role), role `meta` dependencies (role → role).
- **Notes:** Jinja2 `{{ }}` is tolerated; dynamic (templated) includes are dropped.

### Pulumi  (TS/JS/Python programs)
- A **framework detector** over existing source — no new grammar. Recognizes provider SDK resource constructions (`@pulumi/aws`, `/gcp`, `/azure-native`, `/kubernetes`).
- **Nodes:** each detected resource (`address = <Service>:<name>`, `language = Pulumi`).
- **Edges:** when one resource's args reference another resource's variable.
- The normal call graph for those files is unchanged.

## Discovery & disambiguation

`.tf`/`.tfvars`/`.tf.json` map to Terraform by extension. `.yaml`/`.yml`/`.json`
are ambiguous, so they route through a small pure function,
`classifyYaml(path, content)`:

- `apiVersion:` + `kind:` → **Kubernetes**
- `AWSTemplateFormatVersion` / `Transform: AWS::Serverless` / `Resources:` with `Type: AWS::…` → **CloudFormation**
- `Chart.yaml`, or a `{{ … }}` template under `templates/`, or any file under a chart directory → **Helm**
- top-level `hosts:`/playbook list, or a file under `roles/*/{tasks,handlers,…}/` → **Ansible**
- otherwise → `null` (left as generic config — CI files, `docker-compose`, app config are never misclassified as IaC)

## Limits & conservatism

- A reference becomes an edge **only** when the target is unambiguous within the project. Computed names, `for_each` keys, fully-templated values, and dynamic includes produce **no edge** (marked `TODO(spec-07-followup)`), never a wrong one.
- Declared resources are never dropped — only unresolved *edges* are.
- Re-analyzing an unchanged IaC tree yields an identical graph (stable ids, sorted edges).

## Out of scope (future specs)

Bicep, ARM JSON, Kustomize, Crossplane, CDK / CDKTF, Dockerfile,
docker-compose, Jsonnet/CUE, Nix, Bazel/Starlark, Packer, Vagrant.

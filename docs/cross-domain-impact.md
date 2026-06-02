# Cross-Domain Impact Analysis (Code ↔ Infrastructure)

> Spec 17. Deterministic, offline. No API key, no network.

OpenLore parses application code **and** seven Infrastructure-as-Code ecosystems
(Terraform, Pulumi, Kubernetes, CloudFormation, CDK, CDKTF, Ansible, Helm) onto **one
shared graph** — the same `FunctionNode` / `CallEdge` primitives back both. Cross-domain
impact analysis traverses that unified graph end-to-end, so a single query answers
questions a code-only navigator or a grep-based agent structurally cannot:

- **What infrastructure does this code provision?** (forward / blast radius)
- **What code breaks if I change this resource?** (reverse / governing code)

## The connecting edge

Application code and infrastructure used to be disconnected components: both lived in the
graph, but nothing linked them. Spec 17 adds the one deterministic edge that crosses the
boundary — for **embedded IaC** (Pulumi/CDK/CDKTF, where resources are declared *inside*
code), the enclosing code function gets a `references` edge to each resource it provisions:

```
handleProvisionRequest ──calls──▶ deployBucket
                                      │ references (code → infra)
                                      ├──────────▶ Bucket:logs            [Pulumi]
                                      └──────────▶ BucketPolicy:logs-policy [Pulumi]
                                                        │ references (infra → infra)
                                                        ▼
                                                   Bucket:logs
```

The link is purely structural (line containment — the resource is lexically inside the
function), so it is deterministic and requires no matching heuristics. Standalone IaC
(`.tf` / `.yaml` files with no co-located code) has no enclosing function and stays an
infra-only component, exactly as before.

Because the existing graph traversal already walks `references` edges, `analyze_impact`,
`get_subgraph`, and `orient` cross the boundary with **no new tool** — only typed output.

## Reproducible example

Fixture: [`src/core/analyzer/iac/fixtures/cross-domain/app.ts`](../src/core/analyzer/iac/fixtures/cross-domain/app.ts)

```ts
import * as aws from "@pulumi/aws";

export function handleProvisionRequest() {
  return deployBucket();
}

function deployBucket() {
  const logs = new aws.s3.Bucket("logs", { acl: "private" });
  const policy = new aws.s3.BucketPolicy("logs-policy", {
    bucket: logs.id,
    policy: logs.arn,
  });
  return policy;
}
```

### Forward — `analyze_impact("handleProvisionRequest")`

The blast radius now spans infrastructure. Code neighbors stay in the pure-code chains;
infra neighbors are surfaced separately, clearly typed and ecosystem-tagged:

```jsonc
{
  "symbol": "handleProvisionRequest",
  "blastRadius": { "total": 3, "upstream": 0, "downstream": 1, "infrastructure": 2 },
  "downstreamCriticalPath": [ { "name": "deployBucket", "file": "src/app.ts", "depth": 1 } ],
  "crossDomain": {
    "reachesInfrastructure": true,
    "ecosystems": ["Pulumi"],
    "infrastructure": [
      { "nodeType": "infrastructure", "name": "Bucket:logs",            "ecosystem": "Pulumi", "direction": "downstream", "depth": 2 },
      { "nodeType": "infrastructure", "name": "BucketPolicy:logs-policy", "ecosystem": "Pulumi", "direction": "downstream", "depth": 2 }
    ]
  }
}
```

### Reverse — `analyze_impact("Bucket:logs")`

"What code breaks if I change this bucket?" The provisioning code shows up as the
resource's upstream chain, and the dependent infrastructure (the bucket policy that
references it) shows up as a typed upstream `crossDomain` neighbor:

```jsonc
{
  "symbol": "Bucket:logs",
  "language": "Pulumi",
  "blastRadius": { "total": 3, "upstream": 2, "downstream": 0, "infrastructure": 1 },
  "upstreamChain": [
    { "name": "deployBucket",           "file": "src/app.ts", "depth": 1 },
    { "name": "handleProvisionRequest", "file": "src/app.ts", "depth": 2 }
  ],
  "crossDomain": {
    "reachesInfrastructure": true,
    "ecosystems": ["Pulumi"],
    "infrastructure": [
      { "nodeType": "infrastructure", "name": "BucketPolicy:logs-policy", "ecosystem": "Pulumi", "direction": "upstream", "depth": 1 }
    ]
  }
}
```

## Guarantees

- **Additive & typed** — existing code-only `analyze_impact` output is unchanged; the
  `crossDomain` block (and `blastRadius.infrastructure`) appears only when infrastructure is
  actually reached. Infra nodes never leak untyped into the code chains.
- **Deterministic & offline** — pure static analysis over the local graph; identical across
  rebuilds.
- **No schema change** — IaC already shares the graph primitives; the only addition is the
  code→infra `references` edge and typed surfacing.

Tested in [`src/core/analyzer/iac/cross-domain.test.ts`](../src/core/analyzer/iac/cross-domain.test.ts)
(connecting edge, reachability, determinism, standalone-IaC isolation) and the
`analyze_impact` cross-domain block in
[`src/core/services/mcp-handlers/graph.test.ts`](../src/core/services/mcp-handlers/graph.test.ts).

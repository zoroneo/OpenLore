# Dogfood — Docker container graph

End-to-end run of the real `openlore` CLI (built `dist/`) on a fresh repository containing two
Dockerfiles and a docker-compose file. Date: 2026-06-23.

## Fixture repo

```
api/Dockerfile        # 3-stage: deps → builder (COPY --from=deps) → final (COPY --from=builder)
worker/Dockerfile     # single stage on python:3.12-slim
docker-compose.yml    # api(build target=builder), worker(build ./worker), db(postgres:16), cache(redis:7)
src/index.ts          # main() → startServer()   (regression control)
```

## Commands

```
openlore init
openlore analyze --no-embed      # 116ms, keyword (BM25) index
```

## Result — graph (from .openlore/analysis/llm-context.json)

12 Docker-tagged nodes, all edges correct (dependent → dependency):

```
api/Dockerfile::deps      --references--> node:20-alpine
api/Dockerfile::builder   --references--> node:20-alpine
api/Dockerfile::builder   --references--> api/Dockerfile::deps      (COPY --from=deps)
api/Dockerfile::stage2    --references--> api/Dockerfile::builder   (COPY --from=builder)
api/Dockerfile::stage2    --references--> node:20-alpine
worker/Dockerfile::stage0 --references--> python:3.12-slim
docker-compose.yml::service.api    --references--> api/Dockerfile::builder   (build target=builder, cross-file)
docker-compose.yml::service.api    --depends_on--> docker-compose.yml::service.db
docker-compose.yml::service.api    --depends_on--> docker-compose.yml::service.cache
docker-compose.yml::service.worker --references--> worker/Dockerfile::stage0 (build ./worker → final stage)
docker-compose.yml::service.worker --depends_on--> docker-compose.yml::service.db
docker-compose.yml::service.db     --references--> postgres:16
docker-compose.yml::service.cache  --references--> redis:7
main --calls--> startServer    # general-purpose extraction NOT regressed
```

External image nodes are deduped (one `node:20-alpine` node shared by all three api stages).

## The high-value query — blast radius across the code↔infra boundary

"What rebuilds if `node:20-alpine` moves?" (reverse reachability over `node:20-alpine`):

```
api/Dockerfile::deps     [Dockerfile]
api/Dockerfile::builder  [Dockerfile]
api/Dockerfile::stage2   [Dockerfile]
docker-compose.yml::service.api  [Docker Compose]   ← cross-file, transitive
```

The `api` compose service is correctly flagged (it builds the `builder` stage, which derives from
`node:20-alpine`); the `worker` service (python base) is correctly NOT flagged. This is exactly the
deterministic, no-LLM reachability answer the IaC arc promises, now extended to containers.

## orient (real MCP-backed CLI)

```
openlore orient --task "postgres database service dependencies"
  → postgres:16, docker-compose.yml::service.{api,cache,db,worker} surfaced as relevant nodes
```

## Verdict

`analyze → graph → orient` works end-to-end on real container files with zero MCP-tool or schema
changes. No regression to general-purpose or other IaC extraction (full suite: 4692 passed / 2 skipped).

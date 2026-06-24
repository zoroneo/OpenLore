# analyzer spec delta

## ADDED Requirements

### Requirement: DockerContainerGraphIngestion

The system SHALL ingest Dockerfiles and docker-compose files as part of Infrastructure-as-Code analysis,
projecting them onto the existing `FunctionNode`/`CallEdge` primitives via the same normalized
`IacGraph` intermediate used by every other IaC ecosystem. `Dockerfile` and `Docker Compose` SHALL be
members of the IaC language set, so they are treated as infrastructure everywhere the system already
gates on IaC. This ingestion SHALL require no change to the graph schema, the MCP tools, or `orient`,
and SHALL NOT evaluate any container artifact (no `docker build`, no compose interpolation, no registry
access): it is a static parse only.

#### Scenario: A Dockerfile becomes graph nodes and edges

- **GIVEN** a multi-stage Dockerfile with `FROM python:3.12-slim AS builder` and a later
  `FROM builder` (or `COPY --from=builder`)
- **WHEN** the repository is analyzed
- **THEN** each build stage is a node tagged `Dockerfile`, the external base image `python:3.12-slim` is
  an external node, and there are dependency edges from the stage to its base image and from the later
  stage to the `builder` stage

#### Scenario: A compose service resolves to the Dockerfile it builds

- **GIVEN** a `docker-compose.yml` whose `api` service declares `build: ./api` and whose `web` service
  declares `depends_on: [api]`, and an `api/Dockerfile` exists in the repository
- **WHEN** the repository is analyzed
- **THEN** `api` and `web` are nodes tagged `Docker Compose`, there is a `depends_on` edge `web → api`,
  and there is a dependency edge from the `api` service to the final build stage of `api/Dockerfile`, so
  that depth-1 reachability over the base image surfaces both the Dockerfile stage and the compose
  service

#### Scenario: Dynamic references emit no edge

- **GIVEN** a Dockerfile whose base is a build argument (`FROM ${BASE_IMAGE}`) or a compose service whose
  build context is fully templated
- **WHEN** the repository is analyzed
- **THEN** the system emits the node but no dependency edge for the unresolvable reference, rather than a
  speculative or wrong edge

#### Scenario: Detection does not regress incremental watching

- **GIVEN** the incremental watcher, which graphs only a subset of languages and never includes IaC
- **WHEN** Dockerfile and compose support is added
- **THEN** container files are recognized at analyze time through the IaC resolution layer (not through
  `detectLanguage`), so editing a container file under watch never routes through the watcher's
  empty-result node-deletion path, matching the established behavior of all other IaC files

# ADR-0013: Federation registry is a project-local index-of-indexes manifest

## Status

accepted

**Domains**: cli

## Context

Multi-repo federation needs a registry that references each repo's independently-built .openlore index without merging graphs. Store it project-local at .openlore/federation.json (hermetic, deterministic, co-located with the index) rather than ~/.openlore. Each entry is { name, path (absolute), fingerprint, schemaVersion, lastBuilt } sourced from the target repo's .openlore/analysis/fingerprint.json. The home repo (the one holding the registry) is implicitly in scope. Adding/removing a repo edits only the registry plus that repo's own local build — never a global rebuild.

## Decision

The system SHALL maintain a project-local federation registry at .openlore/federation.json that references external repos' independently-built indexes without materializing a union graph.

## Consequences

A new src/core/federation/ module owns registry load/save/add/remove/list. Federated queries load per-repo CachedContext lazily via readCachedContext on demand; no union graph is materialized. Remote (git-remote) repos and a global ~/.openlore registry are deferred to a follow-up.

> Recorded by openlore decisions on 2026-06-19
> Decision ID: bf5aff2d

# config spec delta

## ADDED Requirements

### Requirement: ConfigWritesConfinedToOwnedKey

When OpenLore writes `openspec/config.yaml`, it SHALL confine its writes to its declared owned key
(`openlore`). If a config already exists, OpenLore SHALL preserve every other key and comment
byte-for-byte and SHALL NOT introduce or overwrite a host-owned key (e.g. `version`, `profile`,
`delivery`, `workflows`, `featureFlags`, `plugins`). When the config is host-managed (any host-owned
key is present), OpenLore SHALL additionally skip context auto-injection, since the host owns
`context`. When no config exists, OpenLore MAY create it with `schema`/`context` as the legitimate
creator.

#### Scenario: OpenLore updates only its own block in a host-managed config

- **GIVEN** an `openspec/config.yaml` created by OpenSpec with host-owned keys and a comment
- **WHEN** OpenLore writes its metadata
- **THEN** only the `openlore` block is added or updated and every other key and comment is left
  byte-identical, and no `schema`/`context` key is introduced

#### Scenario: Standalone OpenLore still seeds a fresh config

- **GIVEN** no `openspec/config.yaml` exists
- **WHEN** OpenLore writes its metadata
- **THEN** OpenLore creates the file with `schema: spec-driven` and its `openlore` block

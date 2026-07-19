# Project Specification

> Source files: src/core/services/project-detector.ts

## Purpose

Detects the project type of an analyzed repository (Node.js/TypeScript, Python, Rust, Go, Java,
Ruby, PHP, or unknown) and maps each type key to its human-readable display name. Used to tailor
onboarding and language-aware defaults.

## Entities

### ProjectType

Represents the human-readable name of a project type.

**Properties:**

| Name | Type | Description |
|------|------|-------------|
| typeKey | string | The internal key representing the project type (e.g., 'nodejs', 'python'). |
| displayName | string | The human-readable name of the project type (e.g., 'Node.js/TypeScript', 'Python'). |

## Requirements

### Requirement: ProjectTypeValidation

The system SHALL validate ProjectType according to these rules:
- typeKey must be one of: 'nodejs', 'python', 'rust', 'go', 'java', 'ruby', 'php', 'unknown'
- displayName must be a non-empty string

#### Scenario: GetDisplayNameForNode.jsProjectType
- **GIVEN** The project type key is 'nodejs'
- **WHEN** getProjectTypeName is called with 'nodejs'
- **THEN** The display name is 'Node.js/TypeScript'

#### Scenario: GetDisplayNameForPythonProjectType
- **GIVEN** The project type key is 'python'
- **WHEN** getProjectTypeName is called with 'python'
- **THEN** The display name is 'Python'

#### Scenario: GetDisplayNameForUnknownProjectType
- **GIVEN** The project type key is 'unknown'
- **WHEN** getProjectTypeName is called with 'unknown'
- **THEN** The display name is 'Unknown'

## Technical Notes

- **Implementation**: `src/core/services/project-detector.ts`

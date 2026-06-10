# OpenLore Spec 02 — Canonical Claude Code Skill Bundle

> **Status (verified 2026-06-09): IMPLEMENTED.** The skill bundle ships under `skills/` and is wired
> into the install flow (`src/cli/install/`). No pending work.

> A Claude Code prompt. Paste into a fresh session opened at the OpenLore repo root.

---

## Context for you (the agent)

Anthropic's Claude Code supports **Skills**: self-contained directories under `.claude/skills/` (project) or `~/.claude/skills/` (user) that bundle a `SKILL.md` description, optional scripts, and optional supporting files. The system prompt picks them up; the model invokes them when relevant. Skills are the emerging canonical way for third-party tools to make themselves first-class citizens in Claude Code without requiring users to write `CLAUDE.md` instructions by hand.

This PR ships **the official OpenLore skill bundle** — a versioned, copy-pasteable Skill that anyone can drop into `.claude/skills/openlore/` and immediately have Claude Code use OpenLore correctly. We will also wire `openlore install --agent claude-code` (built in spec-01) to copy this skill into the project automatically, but **this spec does not depend on spec-01 having shipped** — the skill is independently useful and is the artifact this PR delivers.

The repo already has a `skills/` directory at the root. Use it. Do not move it.

## Scope contract — do not break these things

This PR must NOT:

- Add runtime dependencies.
- Change MCP tools, the graph schema, or any CLI behavior outside the new files.
- Add network calls inside any script the skill ships.
- Hardcode an absolute path or assume a specific Node version path.

This PR must:

- Be a static asset drop: markdown + small shell/JS helpers, no build step needed.
- Work with `npx --yes openlore` so no global install is assumed.
- Be small (under ~400 lines of skill content total).

## The deliverable

Create the skill at `skills/openlore-orient/`:

```
skills/openlore-orient/
  SKILL.md                # the skill manifest + instructions Claude reads
  scripts/
    orient.sh             # POSIX wrapper around `npx openlore orient --json`
    orient.ps1            # PowerShell equivalent for Windows users
  examples/
    example-orient-output.json
    example-task-prompt.md
  README.md               # human-facing readme (linked from main repo)
```

### `SKILL.md` requirements

- Frontmatter (YAML) with `name: openlore-orient`, `description:` (one sentence that includes the phrase "persistent architectural memory" so the model picks it up reliably), and a `version:` matching the npm package major.minor.
- Body sections:
  1. **When to use this skill** — explicit triggers: starting a new task in this repo, encountering an unknown function, planning a cross-module change, after the Epistemic Lease prefix appears.
  2. **How to use it** — call `bash scripts/orient.sh "<task description>"` (or the `.ps1` on Windows). The output is JSON; parse the `relevant_functions`, `callers`, `spec_sections`, and `insertion_points` arrays. The skill must also document the option to call the `openlore` MCP server directly if one is configured.
  3. **What NOT to do** — do not start reading source files until `orient()` has been called. Do not call `orient()` on every single edit; respect the Epistemic Lease signal.
  4. **Cost & latency** — typical `orient()` runs in <500ms against a warm graph and ~1–3k tokens of context. Cite the README's published benchmark.
  5. **Failure modes** — if `orient` returns an empty result or errors, fall back to a targeted `grep`/file read on a single file, and report the failure in the response so the user knows the skill silently degraded.

### `scripts/orient.sh`

```sh
#!/usr/bin/env sh
# Wrapper: pass the user task to `openlore orient --json`.
# Exits non-zero with stderr message if openlore is not on PATH AND npx fails.
set -eu
TASK="${1:-}"
if [ -z "$TASK" ]; then
  echo "usage: orient.sh \"<task description>\"" >&2
  exit 2
fi
exec npx --yes openlore orient --json --task "$TASK"
```

The PowerShell version is the same shape. Make both executable.

### `examples/example-orient-output.json`

A realistic, redacted output from running `openlore orient` against this repo itself, captured at the time of the PR. Include enough fields that a reader can see the shape without us having to write a schema doc. ~50 lines is fine.

### `examples/example-task-prompt.md`

A short worked example: "User asks 'add a rate limiter to the API client.' The agent calls the skill with that task. Here is the actual output. Here is how the agent then proceeded." Two or three paragraphs.

### `README.md` (inside the skill dir)

Two-screen explainer:
- What the skill is.
- How to install it (copy the directory to `.claude/skills/`, or wait for `openlore install --agent claude-code` from spec-01 to do it automatically).
- Link to the main OpenLore README.
- License: MIT, matching the parent repo.

### Repo-level integration

- Add a section to the main `README.md` titled **"Use OpenLore as a Claude Code Skill"** with the install instructions (`cp -R skills/openlore-orient ~/.claude/skills/`).
- Add an `npm` script: `"skill:install-local": "node scripts/install-skill.js"` that copies `skills/openlore-orient/` into `~/.claude/skills/openlore-orient/` for the current user. The script is ~30 lines, pure Node, no deps.

## Acceptance criteria

1. `cat skills/openlore-orient/SKILL.md` produces a file with the YAML frontmatter, the required sections, and is ≤ 250 lines.
2. `bash skills/openlore-orient/scripts/orient.sh "test task"` works against the current repo (you may need to run `npm run build` first), producing JSON to stdout.
3. `npm run skill:install-local` copies the skill into `~/.claude/skills/openlore-orient/` and is idempotent.
4. The example JSON file is real output from a real `orient()` invocation, not invented.
5. `npm run lint`, `npm run typecheck`, `npm run test:run`, `npm run build` all pass.
6. No new runtime dependencies. The install-skill script must use only Node built-ins (`fs`, `path`, `os`).

## Git workflow — read carefully

1. Branch: `openlore-spec-02-claude-skill-bundle` off the default branch.
2. Commits scoped to skill files + the README section + the install-skill script. Nothing else.
3. **Open exactly one PR** titled `spec-02: canonical Claude Code skill bundle`. The PR description must include a screenshot or pasted excerpt of `SKILL.md` and a sample `orient.sh` run.
4. All follow-up commits for spec-02 push to that same PR. Never open a second PR for this spec. Re-use the branch.
5. If you find missing functionality in `openlore orient --json` itself (e.g., the `--task` flag doesn't exist yet), do NOT add it here. Leave `TODO(spec-02-followup)` and ship the skill against whatever the current flag surface is — even if that means the wrapper passes the task via stdin or a positional arg. A separate spec can extend the CLI later.
6. Before pushing, run `lint`, `typecheck`, `test:run`, `build`.

## When you are done

Reply with: PR URL, summary, follow-ups, files changed. Nothing else.

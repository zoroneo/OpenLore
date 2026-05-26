# Publishing `openlore` to npm

OpenLore uses **npm Trusted Publishing** (OIDC) so the package is published from CI with no long-lived npm token in any secret store, shell, or laptop. Every published version carries a signed [npm provenance](https://docs.npmjs.com/generating-provenance-statements) attestation linking it to the exact GitHub Actions run that built it.

The CI workflow that does the publish lives at [.github/workflows/release.yml](../.github/workflows/release.yml) and fires automatically when a GitHub Release is published.

## How a release happens

1. Bump the version locally: `npm version <patch|minor|major>` (this creates a `vX.Y.Z` tag).
2. `git push --follow-tags` to push both the bump commit and the tag.
3. On GitHub: **Releases → Draft a new release → choose the `vX.Y.Z` tag → Publish release**.
4. The `Release` workflow runs:
   - `validate` — re-runs `lint`, `typecheck`, `test:run`, `build` against the tagged commit.
   - `publish` — re-builds and runs `npm publish --provenance --access public`. No token; the OIDC handshake with npm authenticates the run.

Manual re-run path if a publish fails mid-way: use **Actions → Release → Run workflow** and pass the tag.

## One-time setup (do this once, then never again)

### 1. Configure Trusted Publishing on npmjs.com

Sign in to npmjs.com as a maintainer of the `openlore` package, then:

- Visit https://www.npmjs.com/package/openlore/access
- Scroll to **Trusted Publisher** and click **Add Trusted Publisher**
- Select **GitHub Actions** as the provider
- Fill in:
  - **Organization or user**: `clay-good`
  - **Repository**: `OpenLore`
  - **Workflow filename**: `release.yml`
  - **Environment name**: `npm-publish` (must match the `environment:` block in `release.yml`)
- Save.

### 2. Create the `npm-publish` deployment environment on GitHub

- Repo → **Settings → Environments → New environment**
- Name: `npm-publish`
- (Optional but recommended) Add a **required reviewer** so every publish requires a human approval click before the workflow can mint an OIDC token.
- (Optional) Restrict to the `main` branch under **Deployment branches**.

### 3. Revoke any existing npm automation tokens

This is the whole point of the migration. From npmjs.com:

- **Account settings → Access Tokens**
- Find any token with publish/write scope on `openlore` (likely labeled something like "openlore-ci" or "automation").
- Click **Revoke**.

If GitHub repo secrets still contain `NPM_TOKEN`, delete that secret too (Settings → Secrets and variables → Actions → remove `NPM_TOKEN`). The workflow no longer references it.

## Verifying a published version

After a release fires, anyone can audit the provenance:

```sh
npm view openlore --json | jq '.dist.attestations'
```

The attestation includes the GitHub workflow file, the commit SHA, and the run ID — anyone reproducing those inputs can confirm the published tarball came from this repo.

## Why Trusted Publishing matters

Long-lived publish tokens are the supply-chain attacker's favorite target — they bypass 2FA, often live in CI secret stores indefinitely, and have been exploited by worms like Shai-Hulud. Trusted Publishing replaces the token with a short-lived OIDC token minted per-workflow-run, scoped to a specific repo + workflow file + environment. There's nothing useful to steal even if a CI runner is compromised.

## Troubleshooting

- **`E401 You must be logged in to publish packages`** — npm's Trusted Publisher config doesn't match the workflow. Double-check the org/repo/workflow filename/environment on npmjs.com against what's in `release.yml`.
- **`Error: Resource not accessible by integration`** — the workflow is missing `id-token: write` permission. It's already set in `release.yml`; if you forked the workflow, copy that line.
- **Workflow fires but never runs the publish job** — check the `npm-publish` environment exists and is reachable from the branch/tag being published.

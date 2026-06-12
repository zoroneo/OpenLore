# Homebrew packaging

openlore is already on npm, so the Homebrew formula ([`openlore.rb`](./openlore.rb))
just installs that published tarball under a Homebrew-managed Node prefix. There
are two ways to get it in front of `brew install` users; a **personal tap** is the
practical choice and needs no approval.

## Option A — personal tap (recommended, available today)

Homebrew installs formulae from *taps* (Git repos named `homebrew-<name>`), not
from a subdirectory of a project repo. So publish the formula to a tap once:

1. Create a public repo `clay-good/homebrew-openlore`.
2. Add this formula at `Formula/openlore.rb` (copy it verbatim from here).
3. Users then install with either:

   ```sh
   brew install clay-good/openlore/openlore
   # or
   brew tap clay-good/openlore && brew install openlore
   ```

`depends_on "node"` pulls in Homebrew's Node (which satisfies openlore's
`engines: node >=22.5.0`), and `std_npm_args` installs the npm tarball into the
formula's `libexec`, symlinking the `openlore` bin onto the user's `PATH`.

## Option B — homebrew-core (wider reach, has a bar to clear)

Submitting to `homebrew-core` makes `brew install openlore` work with no tap, but
core has [notability requirements](https://docs.brew.sh/Acceptable-Formulae)
(meaningful stars/forks/watchers and a stable release history) and review latency.
Pursue this once the tap has traction; the same formula works in both places.

## Releasing a new version

On each npm publish, bump `url` and `sha256` in `openlore.rb` (and mirror the
change into the tap). Compute them from the registry — no manual download of the
repo needed:

```sh
VERSION=$(node -p "require('./package.json').version")
URL="https://registry.npmjs.org/openlore/-/openlore-${VERSION}.tgz"
SHA=$(curl -sL "$URL" | shasum -a 256 | cut -d' ' -f1)
echo "url \"$URL\""
echo "sha256 \"$SHA\""
```

Then run `brew install --build-from-source ./openlore.rb` and `brew test openlore`
against the tap to confirm the formula builds and `openlore --version` matches.

> The `url`/`sha256` in `openlore.rb` are pinned to a specific published version
> on purpose — Homebrew requires a content hash for a fixed artifact, so the
> formula is updated per release rather than tracking "latest".

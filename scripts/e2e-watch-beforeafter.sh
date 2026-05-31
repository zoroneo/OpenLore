#!/bin/bash
# Spec 13.1 before/after E2E: run scripts/e2e-watch-latency.mjs against the
# pre-fix build (a throwaway git worktree at 0368d90, which has the old source
# AND old tests so it compiles) vs the current build, on identical fixtures
# copied from this repo's own src/ + .openlore/analysis. Prints both E2E_RESULT
# lines. Read-only w.r.t. the working tree (uses a detached worktree + temp dirs).
#
# usage: bash scripts/e2e-watch-beforeafter.sh
set -u
MAIN="$(git rev-parse --show-toplevel)"
BASE_REF="${1:-0368d90}"        # pre-fix commit
WT="$(mktemp -d /tmp/ol-oldtree-XXXXXX)"

cleanup() {
  git -C "$MAIN" worktree remove --force "$WT" 2>/dev/null
  rm -rf "${FIX_OLD:-}" "${FIX_NEW:-}" 2>/dev/null
}
trap cleanup EXIT

echo "== building current (fixed) dist =="
( cd "$MAIN" && npm run build >/dev/null 2>&1 ) || { echo "fixed build failed"; exit 1; }

echo "== building pre-fix dist in worktree @$BASE_REF =="
git -C "$MAIN" worktree add --force "$WT" "$BASE_REF" >/dev/null 2>&1 || { echo "worktree add failed"; exit 1; }
ln -sfn "$MAIN/node_modules" "$WT/node_modules"
( cd "$WT" && npm run build >/dev/null 2>&1 ) || { echo "pre-fix build failed"; exit 1; }

# Sanity: confirm the worktree really is pre-fix (no updateFiles / primeContextCache).
echo "pre-fix dist updateFiles=$(grep -c updateFiles "$WT/dist/core/analyzer/vector-index.js" 2>/dev/null) primeContextCache=$(grep -c primeContextCache "$WT/dist/core/services/mcp-handlers/utils.js" 2>/dev/null) (both should be 0)"

mkfix() {
  local d; d="$(mktemp -d /tmp/ol-fix-XXXXXX)"
  mkdir -p "$d/src" "$d/.openlore"
  cp -R "$MAIN/src/." "$d/src/"
  cp -R "$MAIN/.openlore/analysis" "$d/.openlore/analysis"
  cp "$MAIN/package.json" "$d/package.json"
  echo "$d"
}
FIX_OLD="$(mkfix)"
FIX_NEW="$(mkfix)"

echo "== PROBE: pre-fix build =="
node "$MAIN/scripts/e2e-watch-latency.mjs" "$FIX_OLD" "$WT/dist/cli/index.js" OLD
echo "== PROBE: current build =="
node "$MAIN/scripts/e2e-watch-latency.mjs" "$FIX_NEW" "$MAIN/dist/cli/index.js" NEW

#!/usr/bin/env bash
# =============================================================================
# Publish indexer-cli to npm via CI
# =============================================================================
#
# Prerequisites:
#   1. npm Granular Access Token with:
#      - Packages: Read and write
#      - Bypass 2FA: enabled
#      - IP ranges: empty
#   2. Token stored in GitHub repo secret: NPM_TOKEN
#      gh secret set NPM_TOKEN
#   3. All changes committed
#
# Usage:
#   bash scripts/publish.sh
#
# What happens:
#   1. Pushes current commit to master
#   2. GitHub Actions detects the push → builds, tests, bumps version, publishes to npm
#
set -euo pipefail

BRANCH=$(git rev-parse --abbrev-ref HEAD)

if [[ "$BRANCH" != "master" ]]; then
  echo "Error: must be on master branch (currently on $BRANCH)"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is dirty. Commit or stash changes first."
  exit 1
fi

echo "→ Pushing to master..."
git push origin master

echo "✓ Pushed — CI will bump version and publish to npm"

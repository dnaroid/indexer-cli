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
#   1. Bumps patch version locally (package.json + package-lock.json)
#   2. Commits and tags the new version
#   3. Pushes commit + tag to master
#   4. GitHub Actions detects the push → builds, tests, publishes to npm
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

# Pull latest to avoid push rejection
echo "→ Pulling latest from origin..."
git pull --rebase origin master

# Bump version (commits + tags automatically)
echo "→ Bumping patch version..."
NEW_VERSION=$(npm version patch -m "chore(release): %s")
echo "  Version: ${NEW_VERSION}"

# Smoke-test the packed artifact before pushing
echo "→ Running smoke-test on packed artifact..."
bash scripts/smoke-test-package.sh

# Push commit + tag
echo "→ Pushing to master..."
git push origin master
git push origin "${NEW_VERSION}"

echo "✓ Pushed ${NEW_VERSION} — CI will build, test, and publish to npm"

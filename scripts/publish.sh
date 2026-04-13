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
#   3. All changes committed and pushed to master
#
# Usage:
#   bash scripts/publish.sh          # patch bump (0.9.7 → 0.9.8)
#   bash scripts/publish.sh minor    # minor bump (0.9.7 → 1.0.0)
#   bash scripts/publish.sh major    # major bump (1.0.0 → 2.0.0)
#
# What happens:
#   1. Runs tests locally
#   2. Bumps version in package.json and creates git tag (v*)
#   3. Pushes commit + tag to master
#   4. GitHub Actions detects the tag → builds, tests, publishes to npm
#
set -euo pipefail

BUMP="${1:-patch}"

if [[ "$BUMP" != "patch" && "$BUMP" != "minor" && "$BUMP" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

echo "→ Bumping ${BUMP} version..."
npm version "$BUMP" -m "chore(release): %s"

echo "→ Pushing commit and tag..."
git push origin master --follow-tags

VERSION=$(node -p "require('./package.json').version")
echo "✓ Tagged v${VERSION} — CI will publish to npm"

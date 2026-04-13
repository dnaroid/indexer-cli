#!/usr/bin/env bash
set -euo pipefail

echo "→ Bumping patch version..."
npm version patch -m "chore(release): %s"

echo "→ Pushing commit and tag..."
git push origin master --follow-tags

VERSION=$(node -p "require('./package.json').version")
echo "✓ Tagged v${VERSION} — CI will publish to npm"

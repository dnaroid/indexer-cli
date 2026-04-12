#!/usr/bin/env bash
set -euo pipefail

echo "→ Building..."
npm run build

#echo "→ Running tests..."
#npm test

echo "→ Bumping patch version..."
npm version patch -m "chore(release): %s"

echo "→ Publishing to npm..."
npm publish --access public

VERSION=$(node -p "require('./package.json').version")
echo "✓ Published indexer-cli@${VERSION}"

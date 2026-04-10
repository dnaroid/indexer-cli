#!/usr/bin/env bash
set -euo pipefail

echo "→ Building..."
npm run build

echo "→ Running tests..."
npm test

echo "→ Bumping patch version..."
npm version patch -m "chore(release): %s"

echo "→ Publishing to npm..."
if ! npm publish --access public 2>&1 | tee /tmp/npm-publish-output.txt; then
  OUTPUT=$(cat /tmp/npm-publish-output.txt)
  if echo "$OUTPUT" | grep -qE "E404|Not found.*Not found"; then
    echo "⚠ npm session expired. Logging in..."
    npm login
    echo "→ Retrying publish..."
    npm publish --access public
  else
    echo "✗ Publish failed."
    exit 1
  fi
fi

VERSION=$(node -p "require('./package.json').version")
echo "✓ Published indexer-cli@${VERSION}"

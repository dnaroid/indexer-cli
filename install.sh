#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/buzz/indexer-cli.git"
INSTALL_DIR="${INDEXER_INSTALL_DIR:-"$HOME/.indexer-cli"}"

msg()  { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || err "Node.js 18+ is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || err "npm is required"

node_version=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$node_version" -ge 18 ] || err "Node.js 18+ required, got $(node -v)"

msg "Cloning indexer-cli into $INSTALL_DIR"
if [ -d "$INSTALL_DIR" ]; then
	msg "Updating existing installation..."
	git -C "$INSTALL_DIR" pull --ff-only || err "Failed to update. Remove $INSTALL_DIR and re-run."
else
	git clone "$REPO_URL" "$INSTALL_DIR" || err "Clone failed"
fi

msg "Installing dependencies..."
npm install --prefix "$INSTALL_DIR" --production=false || err "npm install failed"

msg "Building project..."
npm run build --prefix "$INSTALL_DIR" || err "Build failed"

msg "Linking globally..."
npm link --prefix "$INSTALL_DIR" 2>/dev/null || npm link --prefix "$INSTALL_DIR" || err "npm link failed"

ok "indexer-cli installed successfully!"
msg "Run 'indexer --help' to get started."

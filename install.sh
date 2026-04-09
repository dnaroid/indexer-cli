#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/dnaroid/indexer-cli.git"
INSTALL_DIR="${INDEXER_INSTALL_DIR:-"$HOME/.indexer-cli"}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCAL_SOURCE_DIR=""

msg()  { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

detect_local_source() {
	if git -C "$SCRIPT_DIR" rev-parse --show-toplevel >/dev/null 2>&1 && [ -f "$SCRIPT_DIR/package.json" ] && [ -f "$SCRIPT_DIR/install.sh" ]; then
		LOCAL_SOURCE_DIR=$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)
	fi
}

sync_local_source() {
	source_dir="$1"
	mkdir -p "$INSTALL_DIR"
	rsync -a --delete \
		--exclude ".git/" \
		--exclude "node_modules/" \
		--exclude "coverage/" \
		--exclude ".indexer-cli/" \
		"$source_dir/" "$INSTALL_DIR/" || err "Failed to copy local source into $INSTALL_DIR"
}

command -v node >/dev/null 2>&1 || err "Node.js 18+ is required (https://nodejs.org)"
command -v npm  >/dev/null 2>&1 || err "npm is required"
command -v git >/dev/null 2>&1 || err "git is required"

node_version=$(node -v | sed 's/^v//' | cut -d. -f1)
[ "$node_version" -ge 18 ] || err "Node.js 18+ required, got $(node -v)"

detect_local_source

if [ -n "$LOCAL_SOURCE_DIR" ]; then
	command -v rsync >/dev/null 2>&1 || err "rsync is required for local checkout installs"
fi

if [ -n "$LOCAL_SOURCE_DIR" ] && [ "$LOCAL_SOURCE_DIR" != "$INSTALL_DIR" ]; then
	msg "Syncing local checkout from $LOCAL_SOURCE_DIR into $INSTALL_DIR"
	sync_local_source "$LOCAL_SOURCE_DIR"
else
	msg "Cloning indexer-cli into $INSTALL_DIR"
	if [ -d "$INSTALL_DIR/.git" ]; then
		msg "Updating existing installation..."
		git -C "$INSTALL_DIR" pull --ff-only || err "Failed to update. Remove $INSTALL_DIR and re-run."
	elif [ -e "$INSTALL_DIR" ] && [ -n "$(ls -A "$INSTALL_DIR" 2>/dev/null)" ]; then
		err "$INSTALL_DIR exists but is not a git checkout. Remove it and re-run."
	else
		git clone "$REPO_URL" "$INSTALL_DIR" || err "Clone failed"
	fi
fi

msg "Installing dependencies from lockfile..."
(cd "$INSTALL_DIR" && npm ci --include=dev) || err "npm ci failed"

msg "Building project..."
(cd "$INSTALL_DIR" && npm run build) || err "Build failed"

msg "Linking globally..."
(cd "$INSTALL_DIR" && npm link) 2>/dev/null || (cd "$INSTALL_DIR" && npm link) || err "npm link failed"

if [ "${INDEXER_SKIP_SETUP:-0}" = "1" ]; then
	msg "Skipping 'indexer-cli setup' because INDEXER_SKIP_SETUP=1"
else
	msg "Running 'indexer-cli setup'..."
	(cd "$INSTALL_DIR" && node "./bin/indexer-cli.js" setup) || err "indexer-cli setup failed"
fi

ok "indexer-cli installed successfully!"
msg "Run 'indexer-cli --help' to get started."

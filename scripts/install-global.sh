#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

find_brew() {
	if [[ -n "${HOMEBREW_PREFIX:-}" && -x "${HOMEBREW_PREFIX}/bin/brew" ]]; then
		printf '%s\n' "${HOMEBREW_PREFIX}/bin/brew"
		return
	fi
	if [[ -x /opt/homebrew/bin/brew ]]; then
		printf '%s\n' /opt/homebrew/bin/brew
		return
	fi
	if [[ -x /usr/local/bin/brew ]]; then
		printf '%s\n' /usr/local/bin/brew
		return
	fi
	return 1
}

BREW="$(find_brew || true)"
if [[ -z "$BREW" ]]; then
	echo "Error: Homebrew is required for npm run install:global." >&2
	exit 1
fi

BREW_PREFIX="$($BREW --prefix)"
NODE_FORMULA="node@24"
NODE_PREFIX="$($BREW --prefix "$NODE_FORMULA" 2>/dev/null || true)"
NODE_BIN="${NODE_PREFIX}/bin/node"
NPM_BIN="${NODE_PREFIX}/bin/npm"

if [[ -z "$NODE_PREFIX" || ! -x "$NODE_BIN" || ! -x "$NPM_BIN" ]]; then
	echo "Error: Homebrew Node 24 is required for the global idx installation." >&2
	echo "Install it with: $BREW install $NODE_FORMULA" >&2
	exit 1
fi

# Keep the entire build/install process on Homebrew Node even when this script was
# invoked from an npm managed by mise, nvm, asdf, or another version manager.
export PATH="${NODE_PREFIX}/bin:${BREW_PREFIX}/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# npm run exports npm_config_prefix from the npm that launched this script. If
# that npm belongs to mise, Homebrew npm would otherwise inherit the mise global
# prefix even though the executable itself is Homebrew's npm. Pin both variants
# explicitly to the Homebrew prefix.
export npm_config_prefix="$BREW_PREFIX"
export NPM_CONFIG_PREFIX="$BREW_PREFIX"

cd "$REPO_ROOT"

echo "→ Building with Homebrew Node 24 ($($NODE_BIN --version))..."
"$NPM_BIN" run build

GLOBAL_PREFIX="$($NPM_BIN prefix -g)"
GLOBAL_ROOT="$($NPM_BIN root -g)"
PACKAGE_ROOT="${GLOBAL_ROOT}/indexer-cli"
CLI_ENTRY="${PACKAGE_ROOT}/bin/indexer-cli.js"
BIN_DIR="${GLOBAL_PREFIX}/bin"

mkdir -p "$BIN_DIR"

remove_managed_launcher() {
	local target="$1"
	if [[ ! -e "$target" && ! -L "$target" ]]; then
		return
	fi

	if [[ -L "$target" ]]; then
		local link_target
		link_target="$(readlink "$target")"
		if [[ "$link_target" == *indexer-cli* ]]; then
			rm -f "$target"
			return
		fi
	else
		if grep -Fq "indexer-cli/bin/indexer-cli.js" "$target" 2>/dev/null; then
			rm -f "$target"
			return
		fi
	fi

	echo "Error: refusing to overwrite unmanaged launcher: $target" >&2
	echo "Move or remove that file manually, then retry." >&2
	exit 1
}

# A previous run replaces npm's bin symlinks with absolute-node wrappers. Remove
# only those managed launchers before reinstalling so repeated installs are
# idempotent and npm does not fail with EEXIST.
remove_managed_launcher "${BIN_DIR}/idx"
remove_managed_launcher "${BIN_DIR}/indexer-cli"

echo "→ Installing indexer-cli into the Homebrew npm prefix..."
"$NPM_BIN" install -g .

if [[ ! -f "$CLI_ENTRY" ]]; then
	echo "Error: global indexer-cli entry point was not installed at $CLI_ENTRY" >&2
	exit 1
fi

write_wrapper() {
	local target="$1"
	rm -f "$target"
	cat > "$target" <<EOF
#!/bin/sh
exec "$NODE_BIN" "$CLI_ENTRY" "\$@"
EOF
	chmod +x "$target"
}

# npm normally creates bin links whose package shebang is `#!/usr/bin/env node`.
# Replace them with absolute Homebrew-Node launchers so runtime resolution cannot
# fall back to mise (or any other Node version manager earlier in PATH).
write_wrapper "${BIN_DIR}/idx"
write_wrapper "${BIN_DIR}/indexer-cli"

echo "✓ Installed global idx without a mise runtime dependency"
echo "  Node: $NODE_BIN"
echo "  Package: $PACKAGE_ROOT"
echo "  idx: ${BIN_DIR}/idx"
"${BIN_DIR}/idx" --version

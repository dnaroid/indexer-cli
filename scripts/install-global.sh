#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

runtime_supported() {
	local node_bin="$1"
	"$node_bin" -e '
	const [major, minor] = process.versions.node.split(".").map(Number);
	process.exit(major < 22 || (major === 22 && minor < 19) || major >= 27 ? 1 : 0);
' >/dev/null 2>&1
}

NODE_BIN=""
NPM_BIN=""
for runtime_dir in /opt/homebrew/bin /usr/local/bin; do
	if [[ -x "$runtime_dir/node" && -x "$runtime_dir/npm" ]] && runtime_supported "$runtime_dir/node"; then
		NODE_BIN="$runtime_dir/node"
		NPM_BIN="$runtime_dir/npm"
		break
	fi
done

if [[ -z "$NODE_BIN" ]]; then
	NODE_BIN="$(command -v node || true)"
	NPM_BIN="$(command -v npm || true)"
fi

if [[ -z "$NODE_BIN" || -z "$NPM_BIN" ]]; then
	echo "Error: node and npm must be available on the system or PATH." >&2
	exit 1
fi

NODE_VERSION="$($NODE_BIN -p 'process.versions.node')"
if ! runtime_supported "$NODE_BIN"; then
	echo "Error: Node $NODE_VERSION does not satisfy indexer-cli engines >=22.19.0 <27." >&2
	exit 1
fi

RUNTIME_BIN_DIR="$(dirname "$NODE_BIN")"
export PATH="$RUNTIME_BIN_DIR:$PATH"

# Use the active npm's own global prefix. Do not inherit a prefix injected by a
# previously active version manager when the current npm comes from elsewhere.
unset npm_config_prefix NPM_CONFIG_PREFIX

cd "$REPO_ROOT"

echo "→ Building with system Node ($($NODE_BIN --version), $NODE_BIN)..."
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

echo "→ Installing indexer-cli into the selected npm global prefix..."
"$NPM_BIN" install -g .

# npm may hide lifecycle output or have scripts disabled; always show this path.
"$NODE_BIN" "$REPO_ROOT/scripts/create-ask-config.cjs"

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

# Bind the global package to the system Node selected for installation. The path
# is stable across ordinary upgrades (for example /opt/homebrew/bin/node) but is
# not tied to a particular Node major or version-manager installation.
write_wrapper "${BIN_DIR}/idx"
write_wrapper "${BIN_DIR}/indexer-cli"

echo "✓ Installed global idx using the selected system Node"
echo "  Node: $NODE_BIN ($NODE_VERSION)"
echo "  Package: $PACKAGE_ROOT"
echo "  idx: ${BIN_DIR}/idx"
"${BIN_DIR}/idx" --version

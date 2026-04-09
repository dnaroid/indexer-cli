#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/dnaroid/indexer-cli.git"
INSTALL_DIR="${INDEXER_INSTALL_DIR:-"$HOME/.indexer-cli"}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
LOCAL_SOURCE_DIR=""
MIN_NODE_MAJOR="18"
LINUX_NODE_SETUP_MAJOR="20"
MAC_NODE_MAJOR="20"

msg()  { printf "\033[1;34m→\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
err()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit 1; }

command_exists() {
	command -v "$1" >/dev/null 2>&1
}

parse_node_major() {
	version="$1"
	version="${version#v}"
	case "$version" in
		""|*[!0-9.]* ) return 1 ;;
	esac
	printf "%s\n" "${version%%.*}"
}

node_major_version() {
	command_exists node || return 1
	version=$(node -v 2>/dev/null) || return 1
	parse_node_major "$version"
}

prepend_to_path_if_dir() {
	dir="$1"
	[ -d "$dir" ] || return 0
	case ":$PATH:" in
		*":$dir:"*) ;;
		*) PATH="$dir:$PATH" ; export PATH ;;
	esac
}

refresh_runtime_path() {
	prepend_to_path_if_dir "/opt/homebrew/bin"
	prepend_to_path_if_dir "/usr/local/bin"
	hash -r 2>/dev/null || true
}

verify_node_runtime() {
	refresh_runtime_path
	command_exists node || return 1
	command_exists npm || return 1
	major=$(node_major_version) || return 1
	[ "$major" -ge "$MIN_NODE_MAJOR" ]
}

detect_node_install_strategy() {
	os_name="${1:-$(uname -s)}"
	has_brew="${2:-}"
	has_apt="${3:-}"

	if [ -z "$has_brew" ]; then
		if command_exists brew; then
			has_brew="1"
		else
			has_brew="0"
		fi
	fi

	if [ -z "$has_apt" ]; then
		if command_exists apt-get; then
			has_apt="1"
		else
			has_apt="0"
		fi
	fi

	if [ "$os_name" = "Darwin" ] && [ "$has_brew" = "1" ]; then
		printf "brew\n"
	elif [ "$os_name" = "Darwin" ]; then
		printf "pkg\n"
	elif [ "$os_name" = "Linux" ] && [ "$has_apt" = "1" ]; then
		printf "apt\n"
	else
		printf "unsupported\n"
	fi
}

run_as_root() {
	if [ "$(id -u)" -eq 0 ]; then
		"$@"
		return
	fi

	command_exists sudo || err "sudo is required for automatic package installation"
	sudo "$@"
}

fetch_remote_script() {
	url="$1"
	if command_exists curl; then
		curl -fsSL "$url"
		return
	fi
	if command_exists wget; then
		wget -qO- "$url"
		return
	fi
	err "curl or wget is required for automatic Node.js installation"
}

download_to_file() {
	url="$1"
	output_path="$2"
	if command_exists curl; then
		curl -fsSL "$url" -o "$output_path"
		return
	fi
	if command_exists wget; then
		wget -qO "$output_path" "$url"
		return
	fi
	err "curl or wget is required for automatic downloads"
}

resolve_latest_node_pkg_name() {
	shasums="$1"
	while IFS= read -r line; do
		case "$line" in
			*" node-v"*.pkg)
				printf "%s\n" "${line##*  }"
				return 0
				;;
		esac
	done <<EOF
$shasums
EOF
	return 1
}

install_node_with_brew() {
	msg "Installing Node.js via Homebrew..."
	brew install node || brew upgrade node || err "Homebrew failed to install Node.js"
	refresh_runtime_path
}

install_node_with_apt() {
	msg "Installing Node.js via NodeSource APT repository..."
	fetch_remote_script "https://deb.nodesource.com/setup_${LINUX_NODE_SETUP_MAJOR}.x" | run_as_root bash -
	run_as_root apt-get install -y -qq nodejs
	refresh_runtime_path
}

install_node_with_mac_pkg() {
	msg "Installing Node.js via the official macOS installer package..."
	shasums=$(fetch_remote_script "https://nodejs.org/dist/latest-v${MAC_NODE_MAJOR}.x/SHASUMS256.txt") || err "Failed to fetch the Node.js package manifest"
	pkg_name=$(resolve_latest_node_pkg_name "$shasums") || err "Failed to determine the latest Node.js macOS package name"
	pkg_url="https://nodejs.org/dist/latest-v${MAC_NODE_MAJOR}.x/${pkg_name}"
	pkg_path=$(mktemp "/tmp/indexer-cli-node.XXXXXX.pkg") || err "Failed to create a temporary file for the Node.js installer"
	trap 'rm -f "$pkg_path"' EXIT
	download_to_file "$pkg_url" "$pkg_path" || err "Failed to download ${pkg_url}"
	run_as_root installer -pkg "$pkg_path" -target / || err "The macOS Node.js installer failed"
	rm -f "$pkg_path"
	trap - EXIT
	refresh_runtime_path
}

ensure_supported_node() {
	if verify_node_runtime; then
		return 0
	fi

	current_version="not installed"
	if command_exists node; then
		current_version=$(node -v 2>/dev/null || printf "unknown")
	fi

	msg "Supported Node.js runtime not found (${current_version}). Bootstrapping Node.js ${MIN_NODE_MAJOR}+..."

	strategy=$(detect_node_install_strategy)
	case "$strategy" in
		brew)
			install_node_with_brew
			;;
		pkg)
			install_node_with_mac_pkg
			;;
		apt)
			install_node_with_apt
			;;
		*)
			err "Node.js ${MIN_NODE_MAJOR}+ and npm are required. Install them manually from https://nodejs.org and re-run."
			;;
	esac

	if ! verify_node_runtime; then
		resolved_version="not available"
		if command_exists node; then
			resolved_version=$(node -v 2>/dev/null || printf "unknown")
		fi
		err "Automatic Node.js installation finished, but a supported runtime is still unavailable (${resolved_version}). Install Node.js ${MIN_NODE_MAJOR}+ manually and re-run."
	fi
}

verify_git_runtime() {
	refresh_runtime_path
	command_exists git || return 1
	git --version >/dev/null 2>&1
}

ensure_supported_git() {
	if verify_git_runtime; then
		return 0
	fi

	os_name=$(uname -s)
	if [ "$os_name" = "Darwin" ] && command_exists xcode-select; then
		msg "Git requires Xcode Command Line Tools on macOS. Requesting installation..."
		xcode-select --install >/dev/null 2>&1 || true
		err "Finish installing Xcode Command Line Tools, then re-run the installer."
	fi

	if [ "$os_name" = "Linux" ] && command_exists apt-get; then
		msg "Installing git via apt-get..."
		run_as_root apt-get update -qq
		run_as_root apt-get install -y -qq git
		verify_git_runtime || err "git installation completed, but git is still unavailable"
		return 0
	fi

	err "git is required"
}

is_direct_execution() {
	current_source="${1:-${BASH_SOURCE:-$0}}"
	invoked_as="${2:-$0}"
	[ "$current_source" = "$invoked_as" ]
}

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

is_npm_ci_lockfile_sync_error() {
	output="${1:-}"
	case "$output" in
		*'`npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync.'*|*'npm error code EUSAGE'*|*'Missing: @esbuild/'*)
			return 0
			;;
		*)
			return 1
			;;
	esac
}

install_dependencies() {
	log_file=$(mktemp "/tmp/indexer-cli-npm-ci.XXXXXX.log") || err "Failed to create npm log file"

	if (cd "$INSTALL_DIR" && npm ci --include=dev) >"$log_file" 2>&1; then
		cat_output=$(<"$log_file")
		[ -z "$cat_output" ] || printf "%s\n" "$cat_output"
		rm -f "$log_file"
		return 0
	fi

	ci_output=$(<"$log_file")
	[ -z "$ci_output" ] || printf "%s\n" "$ci_output" >&2
	rm -f "$log_file"

	if is_npm_ci_lockfile_sync_error "$ci_output"; then
		msg "Lockfile install failed because package metadata is out of sync. Retrying with 'npm install'..."
		(cd "$INSTALL_DIR" && npm install) || err "npm install fallback failed"
		return 0
	fi

	err "npm ci failed"
}

main() {
	ensure_supported_node
	ensure_supported_git

	detect_local_source

	if [ -n "$LOCAL_SOURCE_DIR" ]; then
		command_exists rsync >/dev/null 2>&1 || err "rsync is required for local checkout installs"
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
	install_dependencies

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
}

if is_direct_execution; then
	main "$@"
fi

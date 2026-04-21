#!/usr/bin/env bash
# =============================================================================
# Smoke-test the packed npm tarball before publishing.
#
# Verifies that the artifact a user would install actually works:
#   1. Builds the project
#   2. Packs it into a tarball via npm pack
#   3. Installs the tarball in an isolated temp directory
#   4. Runs basic CLI commands against the installed package
#
# Exit code 0 = all checks passed.
# Exit code non-zero = smoke test failed, do NOT publish.
#
# Usage:
#   bash scripts/smoke-test-package.sh
#   # or via npm:
#   npm run smoke-test
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Allow overriding the tmp location (useful in CI).
SMOKE_TMPDIR="${SMOKE_TMPDIR:-}"

# ── Colors (optional, degrade gracefully) ───────────────────────────────────
if [[ -t 1 ]]; then
    GREEN='\033[0;32m'; RED='\033[0;31m'; BOLD='\033[1m'; RESET='\033[0m'
else
    GREEN=''; RED=''; BOLD=''; RESET=''
fi

pass() { echo -e "  ${GREEN}✓${RESET} $1"; }
fail() { echo -e "  ${RED}✗${RESET} $1" >&2; }
banner() { echo -e "\n${BOLD}$1${RESET}"; }

# ── Cleanup ─────────────────────────────────────────────────────────────────
WORK_DIR=""
cleanup() {
    if [[ -n "$WORK_DIR" && -d "$WORK_DIR" ]]; then
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

# ── Step 1: Build ───────────────────────────────────────────────────────────
banner "Step 1/4: Building project..."
cd "$REPO_ROOT"
npm run build 2>&1

# ── Step 2: Pack ────────────────────────────────────────────────────────────
banner "Step 2/4: Packing tarball..."
TARBALL=$(npm pack --pack-destination "$REPO_ROOT" 2>&1 | tail -n1)
if [[ ! -f "$REPO_ROOT/$TARBALL" ]]; then
    fail "npm pack did not produce expected tarball (got: $TARBALL)"
    exit 1
fi
pass "Created $TARBALL"

# ── Step 3: Install in isolated temp dir ────────────────────────────────────
banner "Step 3/4: Installing tarball in temp directory..."
if [[ -n "$SMOKE_TMPDIR" ]]; then
    WORK_DIR="$SMOKE_TMPDIR/smoke-test-$$"
    mkdir -p "$WORK_DIR"
else
    WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/indexer-cli-smoke-XXXXXX")
fi

# Create a minimal package.json so npm install works cleanly.
cat > "$WORK_DIR/package.json" <<'PKGJSON'
{ "name": "smoke-test-sandbox", "private": true, "version": "0.0.0" }
PKGJSON

npm install --prefix "$WORK_DIR" "$REPO_ROOT/$TARBALL" --no-save 2>&1
pass "Installed tarball in $WORK_DIR"

# Determine the entry-point path inside the installed package.
ENTRY_JS="$WORK_DIR/node_modules/indexer-cli/dist/cli/entry.js"
if [[ ! -f "$ENTRY_JS" ]]; then
    fail "Entry point not found: $ENTRY_JS"
    exit 1
fi

# ── Step 4: Run smoke commands ──────────────────────────────────────────────
banner "Step 4/4: Running smoke commands..."

ERRORS=0

# Helper: run a single smoke command, report result.
# Usage: smoke "<description>" <command...>
smoke() {
    local desc="$1"; shift
    if node "$@" 2>&1; then
        pass "$desc"
    else
        fail "$desc"
        ((ERRORS++)) || true
    fi
}

# 4a. --help on bare CLI
smoke "indexer-cli --help" "$ENTRY_JS" --help

# 4b. bare invocation (no args) — entry.ts outputs help and exits 0
smoke "indexer-cli (no args)" "$ENTRY_JS"

# 4c. setup --help
smoke "idx setup --help" "$ENTRY_JS" setup --help

# 4d. search --help
smoke "idx search --help" "$ENTRY_JS" search --help

# 4e. init --help
smoke "idx init --help" "$ENTRY_JS" init --help

# 4f. --version
smoke "indexer-cli --version" "$ENTRY_JS" --version

# ── Cleanup tarball ─────────────────────────────────────────────────────────
rm -f "$REPO_ROOT/$TARBALL"

# ── Summary ─────────────────────────────────────────────────────────────────
echo ""
if [[ $ERRORS -eq 0 ]]; then
    echo -e "${GREEN}${BOLD}All smoke tests passed.${RESET}"
    exit 0
else
    echo -e "${RED}${BOLD}$ERRORS smoke test(s) FAILED. Do NOT publish.${RESET}" >&2
    exit 1
fi

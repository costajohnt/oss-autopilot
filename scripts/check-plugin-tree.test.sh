#!/usr/bin/env bash
# Test harness for scripts/check-plugin-tree.mjs (#2050).
#
# Builds a small fake plugin tree whose cli.bundle.cjs is a stub that knows
# two commands and, like Commander, prints the program usage for anything
# else, then checks the checker passes it and fails each kind of break.
#
# Run with:
#   bash scripts/check-plugin-tree.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/check-plugin-tree.mjs"

PASS=0
FAIL=0
CURRENT_CASE=""

fail() {
    echo "  FAIL: ${CURRENT_CASE}: $*"
    FAIL=$((FAIL + 1))
}

pass() {
    echo "  PASS: ${CURRENT_CASE}"
    PASS=$((PASS + 1))
}

setup() {
    TREE=$(mktemp -d)
    mkdir -p "${TREE}/agents" "${TREE}/commands" "${TREE}/workflows" "${TREE}/skills/demo" \
        "${TREE}/scripts" "${TREE}/packages/core/dist"
    cat >"${TREE}/packages/core/dist/cli.bundle.cjs" <<'EOF'
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('1.2.3'); process.exit(0); }
if (['daily', 'status', 'checkSetup'].includes(args[0])) { console.log(`Usage: oss-autopilot ${args[0]} [options]`); process.exit(0); }
console.log('Usage: oss-autopilot [options] [command]');
EOF
    echo "#!/usr/bin/env bash" >"${TREE}/scripts/build-cli-if-stale.sh"
    cat >"${TREE}/commands/oss.md" <<'EOF'
Run `"${CLAUDE_PLUGIN_ROOT}/scripts/build-cli-if-stale.sh"`, then read
${CLAUDE_PLUGIN_ROOT}/workflows/flow.md.

```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" daily --json
```
EOF
    cat >"${TREE}/workflows/flow.md" <<'EOF'
```bash
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" \
  status --json
```
EOF
    echo "See <prefix> daily and \`cli.bundle.cjs checkSetup --json\`." >"${TREE}/skills/demo/SKILL.md"
}

teardown() {
    rm -rf "$TREE"
}

run() {
    CURRENT_CASE="$1"
    shift
    setup
    "$@"
    teardown
}

expect_fail_with() {
    out=$(node "$SUBJECT" "$TREE" 2>&1)
    rc=$?
    if [ "$rc" = 0 ]; then
        fail "expected a non-zero exit, got 0 ($out)"
        return
    fi
    echo "$out" | grep -qF "$1" && pass || fail "expected '$1' in the output, got '$out'"
}

# --- Cases -----------------------------------------------------------------

case_good_tree_passes() {
    out=$(node "$SUBJECT" "$TREE" 2>&1)
    rc=$?
    if [ "$rc" != 0 ]; then
        fail "expected exit 0, got $rc ($out)"
        return
    fi
    echo "$out" | grep -q "3 \${CLAUDE_PLUGIN_ROOT} paths present, 3 CLI commands" && pass ||
        fail "expected 3 paths and 3 commands, got '$out'"
}

case_missing_referenced_file_fails() {
    rm "${TREE}/workflows/flow.md"
    echo 'node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" status' >"${TREE}/agents/a.md"
    expect_fail_with 'commands/oss.md: ${CLAUDE_PLUGIN_ROOT}/workflows/flow.md is not in the tree'
}

case_unknown_command_fails() {
    echo 'Then `cli.bundle.cjs nosuch --json`.' >"${TREE}/agents/a.md"
    expect_fail_with 'agents/a.md: cli.bundle.cjs nosuch --help does not describe a nosuch command'
}

case_missing_bundle_fails() {
    rm "${TREE}/packages/core/dist/cli.bundle.cjs"
    expect_fail_with 'packages/core/dist/cli.bundle.cjs is not in the tree'
}

case_crashing_bundle_fails() {
    echo 'process.exit(1);' >"${TREE}/packages/core/dist/cli.bundle.cjs"
    expect_fail_with 'cli.bundle.cjs --version failed'
}

case_no_tree_is_usage_error() {
    node "$SUBJECT" "${TREE}/nope" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 2 ] && pass || fail "expected exit 2 for a missing tree, got $rc"
}

# --- Driver ----------------------------------------------------------------

echo "Running check-plugin-tree.mjs tests..."
run case_good_tree_passes               case_good_tree_passes
run case_missing_referenced_file_fails  case_missing_referenced_file_fails
run case_unknown_command_fails          case_unknown_command_fails
run case_missing_bundle_fails           case_missing_bundle_fails
run case_crashing_bundle_fails          case_crashing_bundle_fails
run case_no_tree_is_usage_error         case_no_tree_is_usage_error

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0

#!/usr/bin/env bash
# Test harness for scripts/build-dashboard-if-stale.sh.
#
# Same shape as scripts/build-cli-if-stale.test.sh -- exercises staleness
# detection, success/failure paths, swap-file exclusion, and the helper's
# special handling of missing pnpm.
#
# Run with:
#   bash scripts/build-dashboard-if-stale.test.sh

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/build-dashboard-if-stale.sh"

if [ ! -x "$SUBJECT" ]; then
    echo "FAIL: subject under test is not executable: $SUBJECT"
    exit 1
fi

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

# Build a fake plugin tree: <root>/packages/dashboard/{src,package.json,vite.config.ts,tsconfig.json,dist/index.html}.
setup() {
    WORK=$(mktemp -d)
    PLUGIN="${WORK}/plugin"
    mkdir -p "${PLUGIN}/packages/dashboard/src" "${PLUGIN}/packages/dashboard/dist"
    echo "{}" >"${PLUGIN}/packages/dashboard/package.json"
    echo "{}" >"${PLUGIN}/packages/dashboard/tsconfig.json"
    echo "// vite config" >"${PLUGIN}/packages/dashboard/vite.config.ts"
    echo "<html></html>" >"${PLUGIN}/packages/dashboard/dist/index.html"
    echo "export const x = 1;" >"${PLUGIN}/packages/dashboard/src/main.tsx"

    # Make the build artifact the most recent file so a later touch of a
    # source file unambiguously beats it.
    sleep 1
    touch "${PLUGIN}/packages/dashboard/dist/index.html"
}

teardown() {
    rm -rf "$WORK"
}

run() {
    CURRENT_CASE="$1"
    shift
    setup
    "$@"
    teardown
}

# Build a tmp directory containing fake pnpm and npm executables that succeed.
make_succeeding_pnpm() {
    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "${fake_bin}/pnpm"
    echo "$fake_bin"
}

# Same shape but the fake commands fail.
make_failing_pnpm() {
    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
    chmod +x "${fake_bin}/pnpm"
    echo "$fake_bin"
}

# A clean PATH with no pnpm anywhere, used to exercise the missing-pnpm branch.
# Includes bash + env so the helper's shebang resolves; includes find +
# coreutils so the staleness check itself can run; deliberately omits pnpm
# and npm so `command -v pnpm` returns false.
clean_path_without_pnpm() {
    new_root=$(mktemp -d)
    mkdir -p "${new_root}/bin"
    for cmd in bash env find mktemp rm sleep mkdir touch echo cd test grep tail cat; do
        path=$(command -v "$cmd")
        if [ -n "$path" ]; then
            ln -sf "$path" "${new_root}/bin/${cmd}"
        fi
    done
    echo "${new_root}/bin"
}

# --- Cases -----------------------------------------------------------------

case_missing_plugin_root() {
    "$SUBJECT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 3 ] && pass || fail "expected exit 3 with no arg + no env, got $rc"
}

case_packages_dashboard_missing() {
    bare=$(mktemp -d)
    "$SUBJECT" "$bare" >/dev/null 2>&1
    rc=$?
    rm -rf "$bare"
    [ "$rc" = 3 ] && pass || fail "expected exit 3 when packages/dashboard absent, got $rc"
}

case_bundle_current_returns_0() {
    "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] && pass || fail "expected exit 0 when bundle is current, got $rc"
}

case_src_newer_triggers_rebuild() {
    sleep 1
    touch "${PLUGIN}/packages/dashboard/src/main.tsx"
    fake_bin=$(make_succeeding_pnpm)
    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 (rebuilt OK) when src is newer, got $rc"
}

case_missing_index_triggers_rebuild() {
    rm "${PLUGIN}/packages/dashboard/dist/index.html"
    fake_bin=$(make_succeeding_pnpm)
    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 (rebuilt OK) when index.html is missing, got $rc"
}

case_swap_files_do_not_trigger_rebuild() {
    sleep 1
    touch "${PLUGIN}/packages/dashboard/src/.main.tsx.swp"
    touch "${PLUGIN}/packages/dashboard/src/.DS_Store"
    touch "${PLUGIN}/packages/dashboard/src/main.tsx~"

    "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] && pass || fail "expected exit 0 when only swap files are newer, got $rc"
}

case_build_failure_returns_2() {
    rm "${PLUGIN}/packages/dashboard/dist/index.html"
    fake_bin=$(make_failing_pnpm)
    out=$(PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    rm -rf "$fake_bin"

    if [ "$rc" != 2 ]; then
        fail "expected exit 2 on build failure, got $rc"
        return
    fi
    if ! echo "$out" | grep -q "BUILD_FAILED"; then
        fail "expected BUILD_FAILED on stdout, got '$out'"
        return
    fi
    pass
}

case_missing_pnpm_returns_2_with_specific_message() {
    rm "${PLUGIN}/packages/dashboard/dist/index.html"
    clean_bin=$(clean_path_without_pnpm)
    out=$(PATH="${clean_bin}" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    rm -rf "$(dirname "$clean_bin")"

    if [ "$rc" != 2 ]; then
        fail "expected exit 2 when pnpm is missing, got $rc"
        return
    fi
    if ! echo "$out" | grep -qi "pnpm is required"; then
        fail "expected missing-pnpm message on stdout, got '$out'"
        return
    fi
    pass
}

case_package_json_newer_triggers_rebuild() {
    sleep 1
    touch "${PLUGIN}/packages/dashboard/package.json"
    fake_bin=$(make_succeeding_pnpm)
    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 when package.json is newer, got $rc"
}

case_optional_configs_can_be_missing() {
    # Strip vite.config.ts and tsconfig.json -- helper must not error on
    # missing optional files.
    rm -f "${PLUGIN}/packages/dashboard/vite.config.ts"
    rm -f "${PLUGIN}/packages/dashboard/tsconfig.json"

    "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] && pass || fail "expected exit 0 with optional configs missing + bundle current, got $rc"
}

# --- Driver ----------------------------------------------------------------

echo "Running build-dashboard-if-stale.sh tests..."
run case_missing_plugin_root                       case_missing_plugin_root
run case_packages_dashboard_missing                case_packages_dashboard_missing
run case_bundle_current_returns_0                  case_bundle_current_returns_0
run case_src_newer_triggers_rebuild                case_src_newer_triggers_rebuild
run case_missing_index_triggers_rebuild            case_missing_index_triggers_rebuild
run case_swap_files_do_not_trigger_rebuild         case_swap_files_do_not_trigger_rebuild
run case_build_failure_returns_2                   case_build_failure_returns_2
run case_missing_pnpm_returns_2_with_specific_message case_missing_pnpm_returns_2_with_specific_message
run case_package_json_newer_triggers_rebuild       case_package_json_newer_triggers_rebuild
run case_optional_configs_can_be_missing           case_optional_configs_can_be_missing

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0

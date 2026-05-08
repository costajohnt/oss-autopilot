#!/usr/bin/env bash
# Test harness for scripts/build-cli-if-stale.sh.
#
# Exercises the staleness-detection paths (missing bundle, src newer, swap-file
# excluded, fully-current). Build-success and build-failure paths are NOT
# exercised end-to-end because that requires a real pnpm/npm install which
# is expensive and brittle in CI; those paths get a tightly-scoped fake-PATH
# unit test instead. Run with:
#   bash scripts/build-cli-if-stale.test.sh
# Exits 0 on all-pass, 1 on first failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/build-cli-if-stale.sh"

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

# Build a fake plugin tree: <root>/packages/core/{src,package.json,tsconfig.json,dist/cli.bundle.cjs}.
# All freshness checks operate on file mtimes within this tree.
setup() {
    WORK=$(mktemp -d)
    PLUGIN="${WORK}/plugin"
    mkdir -p "${PLUGIN}/packages/core/src" "${PLUGIN}/packages/core/dist"
    echo "{}" >"${PLUGIN}/packages/core/package.json"
    echo "{}" >"${PLUGIN}/packages/core/tsconfig.json"
    echo "// existing bundle" >"${PLUGIN}/packages/core/dist/cli.bundle.cjs"
    echo "export const x = 1;" >"${PLUGIN}/packages/core/src/index.ts"

    # Make sure the bundle starts as the most-recent file so a later
    # `touch` of a source file unambiguously beats it.
    sleep 1
    touch "${PLUGIN}/packages/core/dist/cli.bundle.cjs"
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

# --- Cases -----------------------------------------------------------------

case_missing_plugin_root() {
    "$SUBJECT" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 3 ] && pass || fail "expected exit 3 with no arg + no env, got $rc"
}

case_packages_core_missing() {
    bare=$(mktemp -d)
    "$SUBJECT" "$bare" >/dev/null 2>&1
    rc=$?
    rm -rf "$bare"
    [ "$rc" = 3 ] && pass || fail "expected exit 3 when packages/core absent, got $rc"
}

case_bundle_current_returns_0() {
    # Default fixture: bundle is freshly touched, all sources older. Expect
    # no rebuild attempt — exit 0, no PATH manipulation needed.
    "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] && pass || fail "expected exit 0 when bundle is current, got $rc"
}

case_src_newer_triggers_rebuild() {
    # Bump a src file so it beats the bundle, then point pnpm/npm at a stub
    # that succeeds — expect exit 1 (rebuilt OK).
    sleep 1
    touch "${PLUGIN}/packages/core/src/index.ts"

    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat >"${fake_bin}/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "${fake_bin}/pnpm" "${fake_bin}/npm"

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 (rebuilt OK) when src is newer, got $rc"
}

case_missing_bundle_triggers_rebuild() {
    rm "${PLUGIN}/packages/core/dist/cli.bundle.cjs"

    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat >"${fake_bin}/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "${fake_bin}/pnpm" "${fake_bin}/npm"

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 (rebuilt OK) when bundle is missing, got $rc"
}

case_swap_files_do_not_trigger_rebuild() {
    # Editor swap files alongside src/ must NOT make the bundle look stale.
    sleep 1
    touch "${PLUGIN}/packages/core/src/.index.ts.swp"
    touch "${PLUGIN}/packages/core/src/.DS_Store"
    touch "${PLUGIN}/packages/core/src/index.ts~"

    "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    [ "$rc" = 0 ] && pass || fail "expected exit 0 when only swap files are newer, got $rc"
}

case_build_failure_returns_2() {
    # Bundle is missing, but the build tool fails. Expect exit 2 + a
    # BUILD_FAILED line on stdout containing a remediation hint.
    rm "${PLUGIN}/packages/core/dist/cli.bundle.cjs"

    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
    cat >"${fake_bin}/npm" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
    chmod +x "${fake_bin}/pnpm" "${fake_bin}/npm"

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

case_package_json_newer_triggers_rebuild() {
    # Dependency change without src change must still rebuild (catches
    # the original session-start.sh bug from a different angle).
    sleep 1
    touch "${PLUGIN}/packages/core/package.json"

    fake_bin=$(mktemp -d)
    cat >"${fake_bin}/pnpm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    cat >"${fake_bin}/npm" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
    chmod +x "${fake_bin}/pnpm" "${fake_bin}/npm"

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 when package.json is newer, got $rc"
}

# --- Driver ----------------------------------------------------------------

echo "Running build-cli-if-stale.sh tests..."
run case_missing_plugin_root              case_missing_plugin_root
run case_packages_core_missing            case_packages_core_missing
run case_bundle_current_returns_0         case_bundle_current_returns_0
run case_src_newer_triggers_rebuild       case_src_newer_triggers_rebuild
run case_missing_bundle_triggers_rebuild  case_missing_bundle_triggers_rebuild
run case_swap_files_do_not_trigger_rebuild case_swap_files_do_not_trigger_rebuild
run case_build_failure_returns_2          case_build_failure_returns_2
run case_package_json_newer_triggers_rebuild case_package_json_newer_triggers_rebuild

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0

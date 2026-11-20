#!/usr/bin/env bash
# Test harness for scripts/build-cli-if-stale.sh.
#
# Exercises the staleness-detection paths (missing bundle, src newer, swap-file
# excluded, fully-current). Build-success and build-failure paths are NOT
# exercised end-to-end because that requires a real pnpm install which is
# expensive and brittle in CI; those paths run against stub pnpm/npm on PATH
# that record their arguments, which also pins the #1935 contract: the only
# install the helper can run is `pnpm install --frozen-lockfile
# --ignore-scripts`, and npm is never invoked. Run with:
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

# Build a fake source checkout: <root>/pnpm-lock.yaml plus
# <root>/packages/core/{src,package.json,tsconfig.json,dist/cli.bundle.cjs,node_modules/@oss-scout/core}.
# All freshness checks operate on file mtimes within this tree.
setup() {
    WORK=$(mktemp -d)
    PLUGIN="${WORK}/plugin"
    mkdir -p "${PLUGIN}/packages/core/src" "${PLUGIN}/packages/core/dist" \
        "${PLUGIN}/packages/core/node_modules/@oss-scout/core"
    cat >"${PLUGIN}/packages/core/package.json" <<'EOF'
{
  "dependencies": {
    "@oss-scout/core": "^1.3.0"
  }
}
EOF
    echo "{}" >"${PLUGIN}/packages/core/tsconfig.json"
    mkdir -p "${PLUGIN}/scripts"
    echo "// bundle script stub" >"${PLUGIN}/scripts/bundle.mjs"
    echo "lockfileVersion: '9.0'" >"${PLUGIN}/pnpm-lock.yaml"
    echo "// existing bundle" >"${PLUGIN}/packages/core/dist/cli.bundle.cjs"
    echo "export const x = 1;" >"${PLUGIN}/packages/core/src/index.ts"
    cat >"${PLUGIN}/packages/core/node_modules/@oss-scout/core/package.json" <<'EOF'
{
  "name": "@oss-scout/core",
  "version": "1.3.0"
}
EOF
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

case_bundle_script_newer_triggers_rebuild() {
    # A change to the esbuild build script (e.g. its plugins) must rebuild
    # even when src/ and package.json are untouched.
    sleep 1
    touch "${PLUGIN}/scripts/bundle.mjs"

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
    [ "$rc" = 1 ] && pass || fail "expected exit 1 when scripts/bundle.mjs is newer, got $rc"
}

# Stub pnpm and npm that append their arguments to ${WORK}/calls.log, one
# invocation per line, prefixed with the tool name. Sets $fake_bin.
recording_stubs() {
    fake_bin=$(mktemp -d)
    for tool in pnpm npm; do
        printf '#!/usr/bin/env bash\necho "%s $*" >>"%s"\nexit 0\n' "$tool" "${WORK}/calls.log" >"${fake_bin}/${tool}"
        chmod +x "${fake_bin}/${tool}"
    done
}

case_dep_missing_triggers_install() {
    # @oss-scout/core isn't installed at all -> the bundle on disk was not
    # built from this checkout's lockfile, so it is rebuilt.
    rm -rf "${PLUGIN}/packages/core/node_modules/@oss-scout/core"
    recording_stubs

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 (rebuilt) when @oss-scout/core isn't installed, got $rc"
}

case_lockfile_newer_triggers_rebuild() {
    # A pulled lockfile change (new resolved versions) must rebuild even
    # when src/ and package.json are untouched.
    sleep 1
    touch "${PLUGIN}/pnpm-lock.yaml"
    recording_stubs

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    rm -rf "$fake_bin"
    [ "$rc" = 1 ] && pass || fail "expected exit 1 when pnpm-lock.yaml is newer, got $rc"
}

case_rebuild_installs_only_from_frozen_lockfile() {
    # #1935: the rebuild runs exactly one install, from the lockfile, with
    # dependency lifecycle scripts off; it never re-resolves a dependency
    # (`update`/`add`) and never calls npm.
    rm "${PLUGIN}/packages/core/dist/cli.bundle.cjs"
    rm -rf "${PLUGIN}/packages/core/node_modules/@oss-scout/core"
    recording_stubs

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    calls=$(cat "${WORK}/calls.log" 2>/dev/null)
    rm -rf "$fake_bin"

    expected="pnpm install --silent --frozen-lockfile --ignore-scripts
pnpm --silent --filter @oss-autopilot/core run bundle"
    if [ "$rc" != 1 ]; then
        fail "expected exit 1 (rebuilt), got $rc"
        return
    fi
    if [ "$calls" != "$expected" ]; then
        fail "unexpected package-manager calls: '$calls'"
        return
    fi
    pass
}

case_no_pnpm_fails_closed_without_npm() {
    # Stale source checkout, pnpm absent, npm present: the helper must NOT
    # fall back to an unlocked npm install. Exit 2 with an actionable hint.
    rm "${PLUGIN}/packages/core/dist/cli.bundle.cjs"
    recording_stubs
    rm "${fake_bin}/pnpm"

    out=$(PATH="${fake_bin}:/usr/bin:/bin" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    calls=$(cat "${WORK}/calls.log" 2>/dev/null)
    rm -rf "$fake_bin"

    if [ "$rc" != 2 ]; then
        fail "expected exit 2 when pnpm is missing, got $rc"
        return
    fi
    if [ -n "$calls" ]; then
        fail "npm must not be invoked when pnpm is missing, got '$calls'"
        return
    fi
    if ! echo "$out" | grep -q "^BUILD_FAILED: .*pnpm is not on PATH.*--frozen-lockfile"; then
        fail "expected a BUILD_FAILED hint naming pnpm and the frozen install, got '$out'"
        return
    fi
    pass
}

case_missing_lockfile_fails_closed() {
    # No pnpm-lock.yaml -> nothing pins versions -> no install at all.
    rm "${PLUGIN}/packages/core/dist/cli.bundle.cjs" "${PLUGIN}/pnpm-lock.yaml"
    recording_stubs

    out=$(PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    calls=$(cat "${WORK}/calls.log" 2>/dev/null)
    rm -rf "$fake_bin"

    if [ "$rc" != 2 ] || [ -n "$calls" ]; then
        fail "expected exit 2 and no package-manager call without a lockfile, got $rc '$calls'"
        return
    fi
    if ! echo "$out" | grep -q "^BUILD_FAILED: .*pnpm-lock.yaml is missing"; then
        fail "expected a BUILD_FAILED hint naming the missing lockfile, got '$out'"
        return
    fi
    pass
}

case_current_bundle_never_touches_registry() {
    # Bundle current: no package-manager process at all (the old daily
    # `npm view` + `update` refresh is gone).
    recording_stubs

    PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" >/dev/null 2>&1
    rc=$?
    calls=$(cat "${WORK}/calls.log" 2>/dev/null)
    rm -rf "$fake_bin"
    [ "$rc" = 0 ] && [ -z "$calls" ] && pass || fail "expected exit 0 and no package-manager call, got $rc '$calls'"
}

case_prebuilt_layout_returns_0() {
    # The `directory` branch ships only dist/cli.bundle.cjs (no package.json,
    # src/ or node_modules). There is nothing to rebuild from, so the helper
    # must report current instead of attempting an install that cannot work.
    rm -rf "${PLUGIN}/packages/core/src" "${PLUGIN}/packages/core/package.json" \
        "${PLUGIN}/packages/core/tsconfig.json" "${PLUGIN}/packages/core/node_modules"
    out=$(PATH="/usr/bin:/bin" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    [ "$rc" = 0 ] && [ -z "$out" ] && pass || fail "expected exit 0 and no stdout for a prebuilt layout, got $rc '$out'"
}

case_prebuilt_layout_missing_bundle_fails_without_install() {
    # A prebuilt install whose bundle is gone has nothing to build from. It
    # must fail with a reinstall hint and run no package manager.
    rm -rf "${PLUGIN}/packages/core/src" "${PLUGIN}/packages/core/package.json" \
        "${PLUGIN}/packages/core/tsconfig.json" "${PLUGIN}/packages/core/node_modules" \
        "${PLUGIN}/packages/core/dist/cli.bundle.cjs"
    recording_stubs

    out=$(PATH="${fake_bin}:${PATH}" "$SUBJECT" "$PLUGIN" 2>/dev/null)
    rc=$?
    calls=$(cat "${WORK}/calls.log" 2>/dev/null)
    rm -rf "$fake_bin"

    if [ "$rc" != 2 ] || [ -n "$calls" ]; then
        fail "expected exit 2 and no package-manager call, got $rc '$calls'"
        return
    fi
    if ! echo "$out" | grep -q "^BUILD_FAILED: .*Reinstall the oss-autopilot plugin"; then
        fail "expected a BUILD_FAILED reinstall hint, got '$out'"
        return
    fi
    pass
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
run case_bundle_script_newer_triggers_rebuild case_bundle_script_newer_triggers_rebuild
run case_dep_missing_triggers_install         case_dep_missing_triggers_install
run case_lockfile_newer_triggers_rebuild      case_lockfile_newer_triggers_rebuild
run case_rebuild_installs_only_from_frozen_lockfile case_rebuild_installs_only_from_frozen_lockfile
run case_no_pnpm_fails_closed_without_npm     case_no_pnpm_fails_closed_without_npm
run case_missing_lockfile_fails_closed        case_missing_lockfile_fails_closed
run case_current_bundle_never_touches_registry case_current_bundle_never_touches_registry
run case_prebuilt_layout_returns_0           case_prebuilt_layout_returns_0
run case_prebuilt_layout_missing_bundle_fails_without_install case_prebuilt_layout_missing_bundle_fails_without_install

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0

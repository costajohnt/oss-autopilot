#!/usr/bin/env bash
# SessionStart hook for oss-autopilot plugin
# Performs startup checks and outputs additionalContext via JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""
NL=$'\n'

# Rebuild flags (#1059 L1). Accumulated through Steps 1/1.5 and flushed as a
# single consolidated line ("Rebuilt after plugin update: CLI, Dashboard
# SPA.") rather than two separate system-reminder lines, which are quieter in
# the session-start reminder stream.
rebuilt_cli=false
rebuilt_dashboard=false
cli_rebuild_error=""
dashboard_rebuild_error=""

# Marketplace clone path; refresh is handled by safe-refresh-marketplace.sh in Step 2.
MARKETPLACE_DIR="$HOME/.claude/plugins/marketplaces/oss-autopilot"
# Lock file guarding the marketplace-clone fetch+reset against concurrent
# session-starts (#1114). Lock is released automatically when the FD closes
# at script exit; the lock file itself persists as a small stub (deleting it
# would itself race), and the directory is created by Step 2 below as needed.
MARKETPLACE_LOCK="${HOME}/.oss-autopilot/.marketplace-refresh.lock"

# --- Step 1: Rebuild stale CLI bundle (if needed) ---
# Delegate the staleness + build to scripts/build-cli-if-stale.sh (#1292).
# That helper checks src/, package.json, AND tsconfig.json against the bundle
# (the previous inline check only watched package.json, missing the common
# `git pull` case where only src/ changed). Exit codes:
#   0 → not stale; 1 → rebuilt OK; 2 → build attempted and failed.
# `set -e` would short-circuit before the case below, since the helper
# uses non-zero exits as signals (1 = rebuilt, 2 = build failed). Capture
# the exit code without tripping `set -e`.
cli_helper_rc=0
"${PLUGIN_ROOT}/scripts/build-cli-if-stale.sh" "${PLUGIN_ROOT}" >/tmp/oss-autopilot-cli-build.log 2>&1 || cli_helper_rc=$?
case $cli_helper_rc in
  0) ;;  # bundle is current
  1) rebuilt_cli=true ;;
  2)
    cli_rebuild_error="$(grep '^BUILD_FAILED' /tmp/oss-autopilot-cli-build.log | sed 's/^BUILD_FAILED: //')"
    if [ -z "$cli_rebuild_error" ]; then
      if command -v pnpm &>/dev/null; then
        cli_rebuild_error="cd ${PLUGIN_ROOT} && pnpm install && pnpm --filter @oss-autopilot/core run bundle"
      else
        cli_rebuild_error="cd ${PLUGIN_ROOT}/packages/core && npm install && npm run bundle"
      fi
    fi
    ;;
  *) ;;  # exit 3 (invocation error) — leave both rebuilt_cli=false and cli_rebuild_error empty
esac

# --- Step 1.5: Build dashboard SPA if missing or stale ---
# Delegate to scripts/build-dashboard-if-stale.sh (#1292). That helper scans
# src/, vite.config.ts, tsconfig.json, and package.json against dist/index.html,
# excludes editor swap files, and handles the missing-pnpm case explicitly
# (the dashboard depends on @oss-autopilot/core via workspace:* — npm cannot
# resolve that protocol). Exit codes:
#   0 → not stale; 1 → rebuilt OK; 2 → build attempted and failed.
dashboard_helper_rc=0
"${PLUGIN_ROOT}/scripts/build-dashboard-if-stale.sh" "${PLUGIN_ROOT}" >/tmp/oss-autopilot-dashboard-build.log 2>&1 || dashboard_helper_rc=$?
case $dashboard_helper_rc in
  0) ;;  # bundle is current
  1) rebuilt_dashboard=true ;;
  2)
    dashboard_rebuild_error="$(grep '^BUILD_FAILED' /tmp/oss-autopilot-dashboard-build.log | sed 's/^BUILD_FAILED: //')"
    if [ -z "$dashboard_rebuild_error" ]; then
      dashboard_rebuild_error="cd ${PLUGIN_ROOT} && pnpm install && pnpm run build"
    fi
    ;;
  *) ;;  # exit 3 (invocation error) — leave defaults
esac

# Emit a single consolidated line for successful rebuilds, and separate warning
# lines for any rebuild failures (errors are rarer and benefit from being
# immediately legible). #1059 L1.
rebuilt_parts=""
if [ "$rebuilt_cli" = true ]; then rebuilt_parts="CLI"; fi
if [ "$rebuilt_dashboard" = true ]; then
  rebuilt_parts="${rebuilt_parts:+${rebuilt_parts}, }Dashboard SPA"
fi
if [ -n "$rebuilt_parts" ]; then
  messages="${messages:+${messages}${NL}}Rebuilt after plugin update: ${rebuilt_parts}."
fi
if [ -n "$cli_rebuild_error" ]; then
  messages="${messages:+${messages}${NL}}Warning: CLI bundle rebuild failed. Run /oss to retry, or: ${cli_rebuild_error}"
fi
if [ -n "$dashboard_rebuild_error" ]; then
  messages="${messages:+${messages}${NL}}Warning: Dashboard SPA build failed. To fix: ${dashboard_rebuild_error}"
fi

# --- Step 1.75: Verify plugin → CLI contract (#1190) ---
# The markdown command/agent layer references workflow files and CLI commands
# by name. If the bundled CLI changes underneath the plugin (rename, removal,
# new dependency), the markdown silently no-ops on that branch. Cross-check
# the registered command set against the pinned contract and warn if anything
# is missing. Skips silently when jq is unavailable; the cli-registry.docs.test
# pins the contract in CI as a stronger guarantee.
CONTRACT_FILE="${PLUGIN_ROOT}/.claude-plugin/expected-cli-contract.json"
CLI_BUNDLE="${PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"
if [ -f "$CONTRACT_FILE" ] && [ -f "$CLI_BUNDLE" ] && command -v jq &>/dev/null; then
  manifest_json=$(node "$CLI_BUNDLE" manifest --json 2>/dev/null || echo "")
  if [ -n "$manifest_json" ]; then
    # Use `jq -e` so a malformed envelope produces a non-zero exit instead of
    # an empty string that the drift check would silently treat as "no drift"
    # — the exact failure mode #1190's review caught.
    if actual_commands=$(printf '%s' "$manifest_json" | jq -re '.data.commands[].name' 2>/dev/null | sort -u); then
      expected_commands=$(jq -re '.expectedCommands[]' "$CONTRACT_FILE" 2>/dev/null | sort -u || echo "")
      missing_commands=""
      if [ -n "$expected_commands" ]; then
        missing_commands=$(comm -23 <(printf '%s\n' "$expected_commands") <(printf '%s\n' "$actual_commands") | paste -sd, - | sed 's/,/, /g')
      fi
      missing_workflows=""
      while IFS= read -r wf; do
        [ -z "$wf" ] && continue
        [ ! -f "${PLUGIN_ROOT}/${wf}" ] && missing_workflows="${missing_workflows:+${missing_workflows}, }${wf}"
      done < <(jq -r '.expectedWorkflowFiles[]' "$CONTRACT_FILE" 2>/dev/null)
      if [ -n "$missing_commands" ] || [ -n "$missing_workflows" ]; then
        drift_msg="Warning: plugin/CLI contract drift —"
        [ -n "$missing_commands" ] && drift_msg="${drift_msg} missing CLI commands: ${missing_commands};"
        [ -n "$missing_workflows" ] && drift_msg="${drift_msg} missing workflow files: ${missing_workflows};"
        drift_msg="${drift_msg%;}. See .claude-plugin/expected-cli-contract.json."
        messages="${messages:+${messages}${NL}}${drift_msg}"
      fi
    else
      # Manifest produced output we couldn't parse — that's the contract being
      # broken rather than no contract drift; surface it.
      messages="${messages:+${messages}${NL}}Warning: plugin/CLI contract self-check failed — \`manifest --json\` output did not match the expected shape. Run: node ${CLI_BUNDLE} manifest --json"
    fi
  fi
fi

# --- Step 2: Check for updates (every 6 hours) ---
LAST_CHECK="${HOME}/.oss-autopilot/.last-update-check"
CURRENT=$(node -e "console.log(require('${PLUGIN_ROOT}/packages/core/package.json').version)" 2>/dev/null || echo "")

if [ -n "$CURRENT" ]; then
  should_check=false
  if [ ! -f "$LAST_CHECK" ]; then
    should_check=true
  elif [ -n "$(find "$LAST_CHECK" -mmin +360 2>/dev/null)" ]; then
    should_check=true
  fi

  if [ "$should_check" = true ]; then
    mkdir -p "${HOME}/.oss-autopilot"
    LATEST=$(gh api repos/costajohnt/oss-autopilot/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^[^0-9]*//' || echo "")
    # Require full x.y.z semver so partial matches like "1.x" or release tag
    # prefixes that happen to start with digits don't sneak through (#1059 L4).
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+'; then
      # Mark check as done only after a successful API response
      touch "$LAST_CHECK"
      if [ "$LATEST" != "$CURRENT" ]; then
        # Pull marketplace clone so /plugin update sees the new version.
        # Helper preserves dirty trees (exit 1) and reports corrupt-repo state.
        marketplace_pulled=false
        marketplace_skip_msg=""
        # Guard against concurrent SessionStart hooks racing on the same clone
        # with a non-blocking flock (#1114). If another session already holds
        # the lock, skip this run's refresh — the holder will pull the same
        # update, so by the time the user follows the banner's instructions
        # the new version is in place. flock isn't part of POSIX and isn't
        # shipped by default on macOS; if it's missing we fall back to the
        # original unguarded behavior, which is no worse than pre-#1114.
        run_refresh=true
        fd_open=false
        contended=false
        if command -v flock &>/dev/null; then
          # Brace group around the redirect so 2>/dev/null actually catches a
          # bash "9>: cannot open" diagnostic (~ unwritable HOME, lock path
          # exists as a dir, etc.). Without the group, bash emits the error
          # before the redirection takes effect.
          if { exec 9>"${MARKETPLACE_LOCK}"; } 2>/dev/null; then
            fd_open=true
            if ! flock -n 9 2>/dev/null; then
              run_refresh=false
              contended=true
            fi
          fi
        fi
        if [ "$run_refresh" = true ]; then
          refresh_output=$("${SCRIPT_DIR}/safe-refresh-marketplace.sh" "${MARKETPLACE_DIR}") && refresh_rc=0 || refresh_rc=$?
        fi
        if [ "$fd_open" = true ]; then
          # Releasing the FD releases the flock; safe regardless of whether
          # this session held the lock or only opened it.
          exec 9>&-
        fi
        if [ "$contended" = false ]; then
          case "$refresh_rc" in
            0) marketplace_pulled=true ;;
            1) marketplace_skip_msg="$refresh_output" ;;
            2|3) : ;;  # fetch/reset failed or no clone — generic "Auto-pull failed" fires below
            *) marketplace_skip_msg="Auto-refresh helper exited unexpectedly (code ${refresh_rc})." ;;
          esac
        fi
        # Update known_marketplaces.json only if the clone actually refreshed —
        # bumping `lastUpdated` when we skipped the pull would lie about state.
        # Uses atomic write (tmp + mv) to prevent corruption on interruption.
        if [ "$marketplace_pulled" = true ]; then
          KNOWN_MP="${HOME}/.claude/plugins/known_marketplaces.json"
          if [ -f "$KNOWN_MP" ] && command -v jq &>/dev/null; then
            jq --arg ts "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
              'if has("oss-autopilot") then .["oss-autopilot"].lastUpdated = $ts else . end' \
              "$KNOWN_MP" > "${KNOWN_MP}.tmp" \
              && mv "${KNOWN_MP}.tmp" "$KNOWN_MP" \
              || rm -f "${KNOWN_MP}.tmp"
          fi
        fi
        if [ "$marketplace_pulled" = true ]; then
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
        elif [ "$contended" = true ]; then
          # Sister session is doing the pull; the marketplace clone will be
          # fresh by the time the user follows the instructions.
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
        elif [ -n "$marketplace_skip_msg" ]; then
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). ${marketplace_skip_msg} Then run: /plugin update oss-autopilot"
        else
          update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Auto-pull failed. Run: cd ${MARKETPLACE_DIR} && git pull origin main, then /plugin update oss-autopilot"
        fi
        messages="${messages:+${messages}${NL}}${update_msg}"
      fi
    fi
  fi
fi

# --- Step 3: Quick PR health check ---
HEALTH=$(node "${PLUGIN_ROOT}/.claude-plugin/scripts/health-check.cjs" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  messages="${messages:+${messages}${NL}}${HEALTH}"
fi

# --- Output JSON ---
if [ -n "$messages" ]; then
  # Escape for JSON: use jq if available, fall back to sed
  if command -v jq &>/dev/null; then
    escaped=$(printf '%s' "$messages" | jq -Rrs '@json | .[1:-1]')
  else
    # Fallback escaper: jq is preferred and is what produces fully-correct
    # JSON. The sed path only handles the escapes BSD sed can match reliably
    # (`\\`, `"`, `\t`, `\r`) — BSD sed treats `\b` as a word boundary and
    # `\f` as the letter `f`, so attempting to escape those corrupts ordinary
    # prose. Messages emitted by this hook never contain raw 0x08/0x0C bytes,
    # so the gap is acceptable. See #1059 L2 for the investigation.
    escaped=$(printf '%s' "$messages" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\t/\\t/g; s/\r/\\r/g' | tr '\n' ' ')
  fi
  cat <<EOF
{
  "systemMessage": "${escaped}",
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "${escaped}"
  }
}
EOF
else
  # Silent — no output means no system-reminder noise
  cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart"
  }
}
EOF
fi

exit 0

#!/usr/bin/env bash
# SessionStart hook for oss-autopilot plugin
# Performs startup checks and outputs additionalContext via JSON

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

messages=""

# --- Step 1: Rebuild stale bundle (if needed) ---
if [ -f "${PLUGIN_ROOT}/dist/cli.bundle.cjs" ] && [ "${PLUGIN_ROOT}/package.json" -nt "${PLUGIN_ROOT}/dist/cli.bundle.cjs" ]; then
  if (cd "${PLUGIN_ROOT}" && npm install --silent 2>/dev/null && npm run bundle --silent 2>/dev/null); then
    messages="CLI bundle rebuilt after plugin update."
  fi
fi

# --- Step 2: Check for updates (once per day) ---
LAST_CHECK="${HOME}/.oss-autopilot/.last-update-check"
CURRENT=$(node -e "console.log(require('${PLUGIN_ROOT}/package.json').version)" 2>/dev/null || echo "")

if [ -n "$CURRENT" ]; then
  should_check=false
  if [ ! -f "$LAST_CHECK" ]; then
    should_check=true
  elif [ -n "$(find "$LAST_CHECK" -mmin +1440 2>/dev/null)" ]; then
    should_check=true
  fi

  if [ "$should_check" = true ]; then
    mkdir -p "${HOME}/.oss-autopilot"
    touch "$LAST_CHECK"
    LATEST=$(gh api repos/costajohnt/oss-autopilot/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^v//' || echo "")
    # Validate LATEST looks like a version (digits and dots), not an error response
    if [ -n "$LATEST" ] && echo "$LATEST" | grep -qE '^[0-9]+\.' && [ "$LATEST" != "$CURRENT" ]; then
      update_msg="OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
      if [ -n "$messages" ]; then
        messages="${messages}\n${update_msg}"
      else
        messages="$update_msg"
      fi
    fi
  fi
fi

# --- Step 3: Quick PR health check ---
HEALTH=$(node "${PLUGIN_ROOT}/.claude-plugin/scripts/health-check.cjs" 2>/dev/null || echo "")
if [ -n "$HEALTH" ]; then
  if [ -n "$messages" ]; then
    messages="${messages}\n${HEALTH}"
  else
    messages="$HEALTH"
  fi
fi

# --- Output JSON ---
if [ -n "$messages" ]; then
  # Escape for JSON
  escaped=$(printf '%s' "$messages" | sed 's/\\/\\\\/g; s/"/\\"/g')
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

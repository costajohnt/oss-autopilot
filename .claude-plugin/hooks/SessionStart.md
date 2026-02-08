---
name: oss-autopilot-session-start
description: Auto-rebuild stale CLI bundles, check for updates, and show PR health
tools: ["Bash"]
---

Perform three startup checks silently. Only output something if there's a user-relevant message.

**Step 1: Rebuild stale bundle (if needed)**

```bash
if [ -f "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ] && [ "${CLAUDE_PLUGIN_ROOT}/package.json" -nt "${CLAUDE_PLUGIN_ROOT}/dist/cli.bundle.cjs" ]; then
  echo "Rebuilding CLI after plugin update..."
  (cd "${CLAUDE_PLUGIN_ROOT}" && npm install --silent 2>&1 && npm run bundle --silent 2>&1) >/dev/null
  echo "CLI rebuilt successfully."
fi
```

**Step 2: Check for updates (once per day)**

```bash
LAST_CHECK="${HOME}/.oss-autopilot/.last-update-check"
CURRENT=$(node -e "console.log(require('${CLAUDE_PLUGIN_ROOT}/package.json').version)" 2>/dev/null)

if [ ! -f "$LAST_CHECK" ] || [ -n "$(find "$LAST_CHECK" -mmin +1440 2>/dev/null)" ]; then
  mkdir -p "${HOME}/.oss-autopilot"
  touch "$LAST_CHECK"
  LATEST=$(gh api repos/costajohnt/oss-autopilot/releases/latest --jq '.tag_name' 2>/dev/null | sed 's/^v//')
  if [ -n "$LATEST" ] && [ "$LATEST" != "$CURRENT" ]; then
    echo "OSS Autopilot v${LATEST} available (you have v${CURRENT}). Run: /plugin update oss-autopilot"
  fi
fi
```

**Step 3: Quick PR health check (from cached data)**

```bash
HEALTH=$(node "${CLAUDE_PLUGIN_ROOT}/scripts/health-check.cjs" 2>/dev/null)
[ -n "$HEALTH" ] && echo "$HEALTH"
```

If no checks trigger output, the hook is silent — no noise for the user.

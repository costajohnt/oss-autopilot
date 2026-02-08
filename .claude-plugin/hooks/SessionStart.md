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
STATE_FILE="${HOME}/.oss-autopilot/state.json"
if [ -f "$STATE_FILE" ]; then
  HEALTH=$(node -e "
    try {
      const s = require('fs').readFileSync('${HOME}/.oss-autopilot/state.json', 'utf8');
      const state = JSON.parse(s);
      const lastRun = state.lastDigestAt || state.lastRunAt;
      if (!lastRun || !state.lastDigest) process.exit(0);
      const ageMs = Date.now() - new Date(lastRun).getTime();
      const ageDays = Math.floor(ageMs / 86400000);
      const ageHours = Math.floor(ageMs / 3600000);
      const ageLabel = ageDays >= 1 ? ageDays + 'd ago' : ageHours + 'h ago';
      if (ageDays > 7) {
        console.log('OSS: Haven\\'t checked your PRs in ' + ageDays + ' days. Run /oss to catch up.');
      } else {
        const need = state.lastDigest.summary.totalNeedingAttention || 0;
        const total = state.lastDigest.summary.totalActivePRs || 0;
        if (need > 0) {
          console.log('OSS: ' + need + ' of ' + total + ' PRs need attention (' + ageLabel + '). Run /oss to address.');
        }
      }
    } catch(e) {}
  " 2>/dev/null)
  [ -n "$HEALTH" ] && echo "$HEALTH"
fi
```

If no checks trigger output, the hook is silent — no noise for the user.

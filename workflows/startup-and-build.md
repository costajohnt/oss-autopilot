# Startup and Build

> **Session state:** No inputs required. Produces: `version`, `data.daily`, `dashboardUrl`, `issueList`, `setupComplete`, `autoDetected`, `authError`.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Output Style — Loading Screen Pattern

**CRITICAL: Follow this pattern exactly.**

### 1. Display Loading Message FIRST

Before running ANY tool calls, output this text immediately (the user sees it while commands run):

```
Checking your PRs across GitHub...
```

That's it. One line. No narration, no "Let me...", no step-by-step commentary. Just the loading message, then proceed to run commands.

### 2. Run EVERYTHING in a Single Bash Call

After the loading message, execute the **one combined bash command** below. This single call handles build, auth, setup check, daily fetch, dashboard, version, and issue list detection. Do NOT run ANY other tool calls (no Read, no additional Bash) between the loading message and displaying results.

### 3. Only Show Results

After the bash call completes, jump straight to displaying the brief summary and action menu. Do NOT echo the raw JSON. Do NOT narrate what happened. No "Now let me...", no "Let me check...", no intermediate commentary.

**If something fails**, then and only then explain the error.

## Combined Bash Script

Run **everything** in a single bash call. The CLI's `startup` command handles auth, setup, daily fetch, interactive dashboard launch, version detection, and issue list detection internally. The output is a single JSON envelope.

```bash
# Rebuild CLI if needed (check source files, not just package.json)
CLI_BUNDLE="${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"
if [ ! -f "${CLI_BUNDLE}" ] || [ -n "$(find "${CLAUDE_PLUGIN_ROOT}/packages/core/src" "${CLAUDE_PLUGIN_ROOT}/packages/core/package.json" "${CLAUDE_PLUGIN_ROOT}/packages/core/tsconfig.json" -newer "${CLI_BUNDLE}" -print -quit 2>/dev/null)" ]; then
  if ! BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install --silent 2>&1 && npm run bundle --silent 2>&1); then
    echo "BUILD_FAILED"; echo "$BUILD_LOG" | tail -5; exit 1
  fi
fi
# Build dashboard SPA if missing or stale (source files newer than built output) (#567)
# Dashboard's tsc needs core's .d.ts types (the CLI bundle step above runs esbuild, not tsc).
DASHBOARD_INDEX="${CLAUDE_PLUGIN_ROOT}/packages/dashboard/dist/index.html"
DASHBOARD_PKG="${CLAUDE_PLUGIN_ROOT}/packages/dashboard/package.json"
if [ -f "${DASHBOARD_PKG}" ] && { [ ! -f "${DASHBOARD_INDEX}" ] || [ -n "$(find "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/src" "${DASHBOARD_PKG}" "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/vite.config.ts" "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/tsconfig.json" -newer "${DASHBOARD_INDEX}" -print -quit 2>/dev/null)" ]; }; then
  if command -v pnpm &>/dev/null; then
    (cd "${CLAUDE_PLUGIN_ROOT}" && pnpm install --silent && pnpm --silent --filter @oss-autopilot/core run build && pnpm --silent --filter @oss-autopilot/dashboard run build) >/tmp/oss-dashboard-build.log 2>&1 || true
  else
    (cd "${CLAUDE_PLUGIN_ROOT}/packages/dashboard" && npm install --silent && npm run build) >/tmp/oss-dashboard-build.log 2>&1 || true
  fi
fi
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN")
export GITHUB_TOKEN
node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json --compact 2>/tmp/oss-startup-stderr.log
```

## Parse Output

The output is a single JSON object with the standard envelope: `{ success: boolean, data?: StartupOutput, error?: string, timestamp: string }`.

**Error sentinel check** (before JSON appears — only possible if the build step fails):
- If output starts with `BUILD_FAILED`: Tell the user the CLI build failed and show the error lines. Then show error recovery steps (see **Error Recovery** below).

**JSON parsing** — parse the entire output as JSON:

- If `success` is `false`: Show `error` field to the user. This means the daily check failed. Show error recovery steps (see **Error Recovery** below).
- If `success` is `true`, extract `data` as `StartupOutput`:

| Field | Meaning | Session Variable |
|-------|---------|-----------------|
| `data.version` | CLI version (e.g., "0.26.0") | `version` |
| `data.setupComplete` | Whether setup is done | If `false`, prompt setup |
| `data.autoDetected` | Username was auto-detected (zero-config) | If `true`, show welcome message |
| `data.authError` | Set when no GitHub token | If present, show auth instructions |
| `data.daily` | DailyOutput (same shape as before) | Extract `briefSummary`, `actionableIssues`, `actionMenu`, etc. |
| `data.dashboardUrl` | URL of interactive dashboard SPA (e.g., `http://localhost:3000`) | Show `Dashboard: <url>` so user can re-open it |
| `data.issueList` | Issue list info (if detected) | `hasIssueList` = present; extract `path`, `source`, `availableCount`, `completedCount` |

**Routing based on parsed data:**
- `data.authError` is present → Tell the user: show `data.authError` message. Then offer recovery: "Run `gh auth login` to authenticate, then run `/oss` again." End the session — do not continue to Summary or Action Menu without valid auth.
- `data.setupComplete === false` → Auto-detection failed (gh CLI not available or not authenticated). Tell the user: "I couldn't auto-detect your GitHub username. You'll need to set up first." Use AskUserQuestion to let them choose "Run setup (Recommended)" (launch `/setup-oss`) or "Continue with defaults". If they choose "Continue with defaults", re-run the daily check directly (`GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" daily --json 2>/tmp/oss-startup-stderr.log`), use `data.version` from the startup output already received, and return to the core router (`commands/oss.md`) **Summary** section with the daily result as `data.daily`.
- `data.daily` is present → Return to the core router (`commands/oss.md`) **Summary** section.

**If output is empty or not valid JSON**: Tell the user "Something went wrong running the startup check." Suggest running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json`. Then show error recovery steps (see **Error Recovery** below).

## Error Recovery

Show any captured error output (from `$BUILD_LOG`, stderr, or the `error` field). Then troubleshoot based on the error type:

- **Build failure** (BUILD_FAILED sentinel): `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`. Common causes: missing Node.js 20+, stale `node_modules` (delete and reinstall), npm permission issues.
- **Auth/network error** (`success: false` with valid JSON): Check `gh auth status` and network connectivity. The CLI built fine — the daily check itself failed.
- **Invalid output** (empty or non-JSON): Try running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json`. Check `node --version` (need 20+).
- **Dashboard not showing or stale**: The dashboard build is non-blocking. Check `/tmp/oss-dashboard-build.log` for build errors. Rebuild manually: `cd ${CLAUDE_PLUGIN_ROOT}/packages/dashboard && npm install && npm run build`.

**Return:** Core router (`commands/oss.md`) — **Summary** section with the parsed startup data.

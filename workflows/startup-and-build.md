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
# Rebuild CLI bundle if stale (#1292). Helper checks src/, package.json, and
# tsconfig.json against dist/cli.bundle.cjs and exits 0/1/2/3.
CLI_HELPER_RC=0
"${CLAUDE_PLUGIN_ROOT}/scripts/build-cli-if-stale.sh" "${CLAUDE_PLUGIN_ROOT}" >/tmp/oss-startup-cli-build.log 2>&1 || CLI_HELPER_RC=$?
if [ "$CLI_HELPER_RC" = "2" ]; then
  echo "BUILD_FAILED"; tail -5 /tmp/oss-startup-cli-build.log; exit 1
fi

# Build dashboard SPA if stale (#1292). Helper handles workspace:* / pnpm
# requirement explicitly. Map the exit code to the typed status enum in
# OSS_DASHBOARD_BUILD_STATUS so /oss can render a warning when the build
# failed (#1293). The dashboard build is non-blocking — startup proceeds
# either way — but silent failure leaves /oss-dashboard with stale assets.
OSS_DASHBOARD_BUILD_STATUS=fresh
OSS_DASHBOARD_BUILD_ERROR_TAIL=""
DASHBOARD_HELPER_RC=0
"${CLAUDE_PLUGIN_ROOT}/scripts/build-dashboard-if-stale.sh" "${CLAUDE_PLUGIN_ROOT}" >/tmp/oss-dashboard-build.log 2>&1 || DASHBOARD_HELPER_RC=$?
case $DASHBOARD_HELPER_RC in
  0) OSS_DASHBOARD_BUILD_STATUS=fresh ;;
  1) OSS_DASHBOARD_BUILD_STATUS=rebuilt ;;
  2)
    if grep -q "pnpm is required" /tmp/oss-dashboard-build.log; then
      OSS_DASHBOARD_BUILD_STATUS=missing-pnpm
      OSS_DASHBOARD_BUILD_ERROR_TAIL="pnpm not on PATH; install with: npm install -g pnpm"
    else
      OSS_DASHBOARD_BUILD_STATUS=failed
      OSS_DASHBOARD_BUILD_ERROR_TAIL=$(tail -5 /tmp/oss-dashboard-build.log 2>/dev/null | tr '\n' ' ' | tr -s ' ')
    fi
    ;;
  *) ;;  # exit 3 (invocation error) — leave status=fresh, no warning surfaced
esac
export OSS_DASHBOARD_BUILD_STATUS OSS_DASHBOARD_BUILD_ERROR_TAIL
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
| `data.dashboardBuildStatus` | `'fresh' \| 'rebuilt' \| 'failed' \| 'missing-pnpm'` (when set by the workflow) | If `'failed'` or `'missing-pnpm'`, render the warning below before the action menu |
| `data.dashboardBuildErrorTail` | Last few lines of the dashboard build log when `dashboardBuildStatus` is a failure | Quote in the warning so the user sees what broke |
| `data.issueList` | Issue list info (if detected) | `hasIssueList` = present; extract `path`, `source`, `availableCount`, `completedCount` |

**Routing based on parsed data:**
- `data.authError` is present → Tell the user: show `data.authError` message. Then offer recovery: "Run `gh auth login` to authenticate, then run `/oss` again." End the session — do not continue to Summary or Action Menu without valid auth.
- `data.setupComplete === false` → Auto-detection failed (gh CLI not available or not authenticated). Tell the user: "I couldn't auto-detect your GitHub username. You'll need to set up first." Use AskUserQuestion to let them choose "Run setup (Recommended)" (launch `/setup-oss`) or "Continue with defaults". If they choose "Continue with defaults", re-run the daily check directly (`GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN") node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" daily --json 2>/tmp/oss-startup-stderr.log`), use `data.version` from the startup output already received, and return to the core router (`commands/oss.md`) **Summary** section with the daily result as `data.daily`.
- `data.daily` is present → Return to the core router (`commands/oss.md`) **Summary** section.

**Dashboard build warning (#1293):** When `data.dashboardBuildStatus === 'failed'` or `'missing-pnpm'`, render this one-time line above the action menu (after `briefSummary`, before the menu itself):

```
Warning: Dashboard build {failed|requires pnpm} — `/oss-dashboard` may show stale data until rebuilt.
  {data.dashboardBuildErrorTail}
  Rebuild: cd ${CLAUDE_PLUGIN_ROOT} && pnpm install && pnpm --filter @oss-autopilot/dashboard run build
```

Skip the warning when `data.dashboardBuildStatus` is `'fresh'`, `'rebuilt'`, or absent (CLI invoked outside the plugin workflow).

**If output is empty or not valid JSON**: Tell the user "Something went wrong running the startup check." Suggest running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json`. Then show error recovery steps (see **Error Recovery** below).

## Error Recovery

Show any captured error output (from `$BUILD_LOG`, stderr, or the `error` field). Then troubleshoot based on the error type:

- **Build failure** (BUILD_FAILED sentinel): `cd ${CLAUDE_PLUGIN_ROOT}/packages/core && npm install && npm run bundle`. Common causes: missing Node.js 22+, stale `node_modules` (delete and reinstall), npm permission issues.
- **Auth/network error** (`success: false` with valid JSON): Check `gh auth status` and network connectivity. The CLI built fine — the daily check itself failed.
- **Invalid output** (empty or non-JSON): Try running manually: `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" startup --json`. Check `node --version` (need 22+).
- **Dashboard not showing or stale**: The dashboard build is non-blocking. Check `/tmp/oss-dashboard-build.log` for build errors. Rebuild manually: `cd ${CLAUDE_PLUGIN_ROOT}/packages/dashboard && npm install && npm run build`.

**Return:** Core router (`commands/oss.md`) — **Summary** section with the parsed startup data.

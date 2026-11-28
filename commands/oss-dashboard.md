---
name: oss-dashboard
description: "Open the interactive OSS Autopilot dashboard in your browser"
allowed-tools: Bash
---

# Open Dashboard

Launch the interactive OSS Autopilot dashboard SPA. If a server is already running, opens it directly. Otherwise, builds (if needed) and starts the server as a background process.

## Step 1: Build and Launch

Display this loading message before running any tool calls:

```
Opening dashboard...
```

Then run everything in a single bash call:

```bash
# Marketplace installs ship the CLI and dashboard prebuilt, so both helpers
# are no-ops there. In a source checkout they rebuild stale output from
# pnpm-lock.yaml only (frozen install, #1935).
CLI_HELPER_RC=0
OSS_LOG_DIR="$HOME/.oss-autopilot/logs"; mkdir -p -m 700 "$OSS_LOG_DIR"
"${CLAUDE_PLUGIN_ROOT}/scripts/build-cli-if-stale.sh" "${CLAUDE_PLUGIN_ROOT}" >"$OSS_LOG_DIR/oss-dashboard-cli-build.log" 2>&1 || CLI_HELPER_RC=$?
if [ "$CLI_HELPER_RC" = "2" ]; then
  echo '{"error":"CLI build failed","details":"'"$(tail -5 "$OSS_LOG_DIR/oss-dashboard-cli-build.log" | tr '\n' ' ')"'"}'; exit 1
fi
"${CLAUDE_PLUGIN_ROOT}/scripts/build-dashboard-if-stale.sh" "${CLAUDE_PLUGIN_ROOT}" >"$OSS_LOG_DIR/oss-dashboard-build.log" 2>&1 || true

# Pick a platform-appropriate browser opener. $BROWSER wins when set.
open_url() {
  local url="$1"
  if [ -n "$BROWSER" ] && command -v "$BROWSER" >/dev/null 2>&1; then
    "$BROWSER" "$url" >/dev/null 2>&1 &
  elif command -v open >/dev/null 2>&1; then        # macOS
    open "$url" >/dev/null 2>&1 &
  elif command -v xdg-open >/dev/null 2>&1; then    # Linux
    xdg-open "$url" >/dev/null 2>&1 &
  elif command -v wslview >/dev/null 2>&1; then     # WSL
    wslview "$url" >/dev/null 2>&1 &
  elif command -v cmd.exe >/dev/null 2>&1; then     # Git Bash / Cygwin on Windows
    cmd.exe /c start "" "$url" >/dev/null 2>&1 &
  else
    return 1
  fi
}

# One CLI call reuses the running server or starts one, with the same
# version check and /api/health probe as /oss: a server older than this CLI
# is replaced, a newer one is left alone (#2039, #1882). Only JSON goes to
# stdout; server output goes to ~/.oss-autopilot/dashboard.log.
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN")
export GITHUB_TOKEN
RESULT=$(node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dashboard launch --port 3000 --json)
URL=$(printf '%s' "$RESULT" | node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{try{const j=JSON.parse(s);if(j.success)console.log(j.data.url)}catch{}})')
if [ -n "$URL" ]; then
  open_url "$URL" || true
fi
echo "$RESULT"
```

## Step 2: Display Result

Parse the JSON output (the CLI's `{ success, data, error }` envelope):

- If `data.status` is `"already_running"`: Show `Dashboard: <data.url>` (already open in browser). If the system didn't have a usable browser opener, tell the user to open the URL manually. If that page never loads, the running server may be from a newer plugin version than this session, which this command never replaces: tell the user to run `/oss-dashboard` from a session on the latest plugin version (restart Claude Code after updating), or to stop the process recorded in `~/.oss-autopilot/dashboard-server.pid` and run `/oss-dashboard` again.
- If `data.status` is `"launched"`: Show `Dashboard opened: <data.url>`. Same caveat for headless systems. Server logs are in `data.logFile`.
- If `success` is false or the output is not JSON: Show the `error` message (or the raw output). The message names the log file when the server failed to start, so the user can inspect the dashboard server output. If the error is a build failure, show the `BUILD_FAILED` line from the details: it carries the fix (reinstall the plugin for a marketplace install; `pnpm install --frozen-lockfile --ignore-scripts` plus a rebuild for a source checkout). Never suggest an install that ignores the lockfile.

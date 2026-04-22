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
CLI_BUNDLE="${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs"

# Rebuild CLI if needed
if [ ! -f "${CLI_BUNDLE}" ] || [ -n "$(find "${CLAUDE_PLUGIN_ROOT}/packages/core/src" "${CLAUDE_PLUGIN_ROOT}/packages/core/package.json" "${CLAUDE_PLUGIN_ROOT}/packages/core/tsconfig.json" -newer "${CLI_BUNDLE}" -print -quit 2>/dev/null)" ]; then
  if ! BUILD_LOG=$(cd "${CLAUDE_PLUGIN_ROOT}/packages/core" && npm install --silent 2>&1 && npm run bundle --silent 2>&1); then
    echo '{"error":"CLI build failed","details":"'"$(echo "$BUILD_LOG" | tail -5 | tr '\n' ' ')"'"}'; exit 1
  fi
fi

# Build dashboard SPA if missing or stale
DASHBOARD_INDEX="${CLAUDE_PLUGIN_ROOT}/packages/dashboard/dist/index.html"
DASHBOARD_PKG="${CLAUDE_PLUGIN_ROOT}/packages/dashboard/package.json"
if [ -f "${DASHBOARD_PKG}" ] && { [ ! -f "${DASHBOARD_INDEX}" ] || [ -n "$(find "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/src" "${DASHBOARD_PKG}" "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/vite.config.ts" "${CLAUDE_PLUGIN_ROOT}/packages/dashboard/tsconfig.json" -newer "${DASHBOARD_INDEX}" -print -quit 2>/dev/null)" ]; }; then
  if command -v pnpm &>/dev/null; then
    (cd "${CLAUDE_PLUGIN_ROOT}" && pnpm install --silent && pnpm --silent --filter @oss-autopilot/core run build && pnpm --silent --filter @oss-autopilot/dashboard run build) >/tmp/oss-dashboard-build.log 2>&1 || true
  else
    (cd "${CLAUDE_PLUGIN_ROOT}/packages/dashboard" && npm install --silent && npm run build) >/tmp/oss-dashboard-build.log 2>&1 || true
  fi
fi

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

# Dashboard logs go here so crashes are debuggable instead of silently lost.
LOG_DIR="$HOME/.oss-autopilot"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/dashboard.log"

# Check if dashboard server is already running via PID file
PID_FILE="$HOME/.oss-autopilot/dashboard-server.pid"
if [ -f "$PID_FILE" ]; then
  PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).port)}catch(e){console.log('')}")
  PID=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).pid)}catch(e){console.log('')}")
  if [ -n "$PORT" ] && [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    # Health check
    if curl -sf "http://127.0.0.1:$PORT/api/data" -o /dev/null 2>/dev/null; then
      open_url "http://oss.localhost:$PORT" || true
      echo '{"status":"already_running","url":"http://oss.localhost:'"$PORT"'","logFile":"'"$LOG_FILE"'"}'
      exit 0
    fi
  fi
fi

# Launch server in background, routing stderr/stdout to a log file for debugging.
GITHUB_TOKEN=$(gh auth token 2>/dev/null || echo "$GITHUB_TOKEN")
export GITHUB_TOKEN
{ echo "--- dashboard server started $(date -u +%FT%TZ) ---"; } >>"$LOG_FILE" 2>&1
nohup node "${CLI_BUNDLE}" dashboard serve --port 3000 --no-open >>"$LOG_FILE" 2>&1 &

# Wait for server to start (poll PID file + health check)
for i in $(seq 1 25); do
  sleep 0.2
  if [ -f "$PID_FILE" ]; then
    PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$PID_FILE','utf-8')).port)}catch(e){console.log('')}")
    if [ -n "$PORT" ] && curl -sf "http://127.0.0.1:$PORT/api/data" -o /dev/null 2>/dev/null; then
      open_url "http://oss.localhost:$PORT" || true
      echo '{"status":"launched","url":"http://oss.localhost:'"$PORT"'","logFile":"'"$LOG_FILE"'"}'
      exit 0
    fi
  fi
done

echo '{"error":"Dashboard server failed to start within 5 seconds","logFile":"'"$LOG_FILE"'"}'
exit 1
```

## Step 2: Display Result

Parse the JSON output:

- If `status` is `"already_running"`: Show `Dashboard: <url>` (already open in browser). If the system didn't have a usable browser opener, tell the user to open the URL manually.
- If `status` is `"launched"`: Show `Dashboard opened: <url>`. Same caveat for headless systems.
- If `error` is present: Show the error message, plus `Logs: <logFile>` when the field is set so the user can inspect the dashboard server output. If the error is a build failure, suggest running `cd packages/core && npm run bundle` and `cd packages/dashboard && npm run build` manually.

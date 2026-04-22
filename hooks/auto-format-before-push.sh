#!/usr/bin/env bash
# PreToolUse hook: auto-format changed files before git push.
#
# Opt-in via `~/.oss-autopilot/state.json`'s `config.autoFormatBeforePush`.
# When enabled, detects the project's formatter, runs it once over the full
# list of changed files, and commits any formatting changes before the push
# proceeds. Passes through silently if disabled, if no formatter is detected,
# or if nothing changes. Never blocks a push — all errors fall through with a
# warning message.
#
# Why opt-in (#1045): appending a `style: auto-format before push` commit to
# an OSS contribution branch can surprise maintainers who prefer minimal-diff
# PRs, and conflicts with the global "never reformat unrelated code" rule.

# No set -e: this hook must never abort mid-execution and leave a dirty tree.
set -uo pipefail

STATE_FILE="${HOME}/.oss-autopilot/state.json"
FORMAT_ERROR_LOG="${HOME}/.oss-autopilot/last-format-error.log"

warn_and_exit() {
  local msg="$1"
  cat <<WARN_EOF
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "updatedInput": {}
  },
  "systemMessage": "Auto-format hook: ${msg}"
}
WARN_EOF
  exit 0
}

# Read a config value from state.json via jq; fall back to default on any
# failure (missing file, malformed JSON, missing key). Never throws.
read_config() {
  local key="$1"
  local default="$2"
  if [ ! -f "$STATE_FILE" ]; then
    echo "$default"
    return
  fi
  jq -r --arg default "$default" ".config.${key} // \$default" "$STATE_FILE" 2>/dev/null || echo "$default"
}

# Lowercase helper — portable to bash 3.2 (macOS) where ${var,,} is unavailable.
to_lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

input=$(cat)
command=$(echo "$input" | jq -r '.tool_input.command // empty')

if [ -z "$command" ]; then
  exit 0
fi

# Only trigger on git push (skip force pushes — guard-git-operations.sh handles those)
if ! echo "$command" | grep -qE 'git\s+push\b'; then
  exit 0
fi
if echo "$command" | grep -qE '(\s--force\b|\s-f\b|\s--force-with-lease)'; then
  exit 0
fi

# ── Opt-in gate (#1045) ──────────────────────────────────────────────
# Silent no-op unless the user has explicitly enabled the hook via
# `oss-autopilot setup --set autoFormatBeforePush=true`.
auto_format_enabled=$(read_config autoFormatBeforePush false)
if [ "$auto_format_enabled" != "true" ]; then
  exit 0
fi

# Safety: skip if working tree or index has uncommitted changes.
# Running a formatter on a dirty tree risks destroying carefully staged state.
if ! git diff --quiet 2>/dev/null || ! git diff --cached --quiet 2>/dev/null; then
  exit 0
fi

# Find changed files compared to remote tracking branch (exclude deleted files).
# Fall back to origin/main for first push of new branches.
tracking_branch=$(git rev-parse --abbrev-ref '@{upstream}' 2>/dev/null || echo "")
if [ -z "$tracking_branch" ]; then
  tracking_branch=$(git rev-parse --verify origin/main >/dev/null 2>&1 && echo "origin/main" || echo "")
fi
if [ -z "$tracking_branch" ]; then
  exit 0
fi

# ── OSS-contribution branch skip (#1045) ─────────────────────────────
# If the branch tracks a remote whose URL owner doesn't match the user's
# configured GitHub username, we're pushing to a fork's upstream — don't
# append a style commit to that PR.
current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
github_user=$(read_config githubUsername "")
if [ -n "$current_branch" ] && [ -n "$github_user" ]; then
  remote_name=$(git config "branch.${current_branch}.remote" 2>/dev/null || echo "")
  if [ -n "$remote_name" ]; then
    remote_url=$(git remote get-url "$remote_name" 2>/dev/null || echo "")
    # Match both https://github.com/OWNER/ and git@github.com:OWNER/
    remote_owner=$(printf '%s' "$remote_url" | sed -nE 's#.*github\.com[:/]+([^/]+)/.*#\1#p')
    if [ -n "$remote_owner" ]; then
      if [ "$(to_lower "$remote_owner")" != "$(to_lower "$github_user")" ]; then
        warn_and_exit "Skipped: branch '${current_branch}' tracks remote owner '${remote_owner}' (not '${github_user}'). Auto-format is disabled on OSS contribution branches."
      fi
    fi
  fi
fi

# Collect changed files null-delimited so filenames with spaces/quotes survive.
changed_files_tmp=$(mktemp)
trap 'rm -f "$changed_files_tmp"' EXIT
if ! git diff -z --name-only --diff-filter=d "$tracking_branch"..HEAD >"$changed_files_tmp" 2>/dev/null; then
  exit 0
fi
if [ ! -s "$changed_files_tmp" ]; then
  exit 0
fi

# Ensure the data directory exists for the error log.
mkdir -p "$(dirname "$FORMAT_ERROR_LOG")" 2>/dev/null || true

# Batched formatter helpers (#1045): run the formatter once (or at most a few
# times if xargs splits the command line) rather than once per file. A 50-file
# diff used to spawn 50 `npx` processes, each resolving `.bin/` — easily past
# the hook timeout (currently 60s in hooks.json). `-r` skips the call entirely
# if the list is empty.
run_formatter() {
  local name="$1"
  shift
  if xargs -0 -r "$@" 2>>"$FORMAT_ERROR_LOG" >/dev/null <"$changed_files_tmp"; then
    format_result="$name"
  else
    format_error="$name exited non-zero; see ${FORMAT_ERROR_LOG}"
  fi
}

run_python_formatter() {
  local name="$1"
  shift
  local py_files_tmp
  py_files_tmp=$(mktemp)
  tr '\0' '\n' <"$changed_files_tmp" | grep '\.py$' | tr '\n' '\0' >"$py_files_tmp" 2>/dev/null || true
  if [ -s "$py_files_tmp" ]; then
    if xargs -0 -r "$@" 2>>"$FORMAT_ERROR_LOG" >/dev/null <"$py_files_tmp"; then
      format_result="$name"
    else
      format_error="$name exited non-zero; see ${FORMAT_ERROR_LOG}"
    fi
  fi
  rm -f "$py_files_tmp"
}

# Detect and run project formatter
format_result=""
format_error=""

if [ -f "package.json" ]; then
  # Detect which format script exists
  format_script=$(node -e "
    const p=require('./package.json');
    const s=p.scripts||{};
    if(s.format) console.log('format');
    else if(s['format:fix']) console.log('format:fix');
    else if(s['format:write']) console.log('format:write');
  " 2>/dev/null || echo "")

  if [ -n "$format_script" ]; then
    if [ -f "pnpm-lock.yaml" ]; then
      if pnpm run "$format_script" >/dev/null 2>>"$FORMAT_ERROR_LOG"; then
        format_result="pnpm run $format_script"
      fi
    elif [ -f "yarn.lock" ]; then
      if yarn run "$format_script" >/dev/null 2>>"$FORMAT_ERROR_LOG"; then
        format_result="yarn run $format_script"
      fi
    else
      if npm run "$format_script" >/dev/null 2>>"$FORMAT_ERROR_LOG"; then
        format_result="npm run $format_script"
      fi
    fi
  fi
fi

# Fallback: check for standalone formatter config files
if [ -z "$format_result" ] && [ -z "$format_error" ]; then
  if [ -f ".prettierrc" ] || [ -f ".prettierrc.json" ] || [ -f "prettier.config.js" ] || [ -f "prettier.config.mjs" ] || [ -f ".prettierrc.yaml" ]; then
    run_formatter "prettier" npx prettier --write
  elif [ -f "biome.json" ] || [ -f "biome.jsonc" ]; then
    run_formatter "biome" npx @biomejs/biome format --write
  elif [ -f "pyproject.toml" ] && grep -qE '\[tool\.(black|ruff)\]' pyproject.toml 2>/dev/null; then
    if command -v ruff >/dev/null 2>&1; then
      run_python_formatter "ruff format" ruff format
    elif command -v black >/dev/null 2>&1; then
      run_python_formatter "black" black
    fi
  fi
fi

# If formatter was detected but failed, warn and allow push
if [ -z "$format_result" ] && [ -n "$format_error" ]; then
  warn_and_exit "Formatter failed. Push continuing without formatting. ${format_error}"
fi

if [ -z "$format_result" ]; then
  exit 0
fi

# Check if formatting changed anything
if git diff --quiet 2>/dev/null; then
  exit 0
fi

# Stage ONLY files that the formatter actually modified. Null-delimited names
# survive spaces and other special characters.
if ! git diff --name-only -z 2>/dev/null | xargs -0 -r git add >/dev/null 2>&1; then
  warn_and_exit "Failed to stage formatting changes (git add failed). Push continuing without formatting commit."
fi

if ! git commit -m "style: auto-format before push" >/dev/null 2>&1; then
  warn_and_exit "Failed to commit formatting changes. Push continuing without formatting commit."
fi

cat <<EOF
{
  "hookSpecificOutput": {
    "permissionDecision": "allow",
    "updatedInput": {}
  },
  "systemMessage": "Auto-formatted changed files (${format_result}) and committed as 'style: auto-format before push'. The push will include this formatting commit."
}
EOF
exit 0

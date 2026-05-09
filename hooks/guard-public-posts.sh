#!/usr/bin/env bash
# PreToolUse hook: intercept any tool call that posts publicly to GitHub or
# otherwise produces an externally-visible event (create/merge/close PRs,
# create/close issues, create releases, invoke MCP `post` / `claim`).
# Returns "ask" so Claude Code prompts the user for approval; does NOT
# block silently.
#
# This hook is wired to two PreToolUse matchers in hooks.json:
#   - Bash — inspects `tool_input.command` against a regex of gh/CLI patterns
#   - mcp__plugin_oss-autopilot_oss-autopilot__(post|claim) — always asks
#
# Drift-resistance: `packages/mcp-server/src/tools.test.ts`
# (`describe('hooks.json guard-public-posts matcher (#1302 item 2)')`)
# pins the matcher's plugin-tool list to the tool registry's
# `destructiveHint` annotations. Adding a new tool with `destructiveHint:
# true` that posts publicly without updating the matcher fails CI; an
# explicit exclusion list covers the LOCAL_ONLY_DESTRUCTIVE case.
#
# Known static-analysis limits (regressions here are intentional gaps, not
# silent failures — they're called out with explicit test assertions in
# guard-public-posts.test.sh):
#   - Dynamic verbs: `eval "gh pr $v 1"` or aliases expanded at runtime
#   - Command substitution in place of `gh`: `$(which gh) pr merge`
#   - Any curl invocation that doesn't clearly target api.github.com's
#     posting endpoints

set -uo pipefail

emit_ask() {
    # Use jq -n when possible so future dynamic messages get proper JSON
    # escaping for free. Falls back to a handcrafted heredoc if jq is
    # broken (very unlikely by the time we reach this path — we check
    # for jq at startup below).
    if command -v jq >/dev/null 2>&1; then
        jq -nc --arg msg "$1" '{
          hookSpecificOutput: {permissionDecision: "ask", updatedInput: {}},
          systemMessage: $msg
        }'
    else
        # If jq is missing, we already emit a loud ask from the startup
        # check below; this branch is a last-resort fallback.
        cat <<EOF
{"hookSpecificOutput":{"permissionDecision":"ask","updatedInput":{}},"systemMessage":"guard-public-posts: refusing to parse tool input without jq. Install jq and retry."}
EOF
    fi
}

# --- Hard dependency: jq -----------------------------------------------------
# Previously this script swallowed jq errors via `|| true`, which meant that
# on a machine without jq the guard silently allowed every public post. Prefer
# a loud ask with install instructions (#1032 silent-failure review).
if ! command -v jq >/dev/null 2>&1; then
    emit_ask "guard-public-posts: the 'jq' utility is required to inspect tool input. Install it (brew install jq / apt-get install jq) and retry. Treating this invocation as 'ask' to avoid silently bypassing the public-post guard."
    exit 0
fi

input=$(cat 2>/dev/null || echo "")
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null || true)

case "$tool_name" in
    Bash)
        command=$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)
        if [ -z "$command" ]; then
            exit 0
        fi

        # Normalize the command string before pattern-matching:
        # - strip single / double quotes so `gh pr 'merge' 1` still matches
        # - remain conservative on other shell metacharacters (they would
        #   usually require a subshell to take effect)
        normalized=$(printf '%s' "$command" | tr -d "\"'")

        # Public-post patterns. This is intentionally permissive — false
        # positives ("ask" on a benign command) are preferable to misses.
        #
        #   - gh api with a mutating method (POST/PATCH/PUT/DELETE)
        #   - gh api with -f / -F / --field / --raw-field flags. Per
        #     `gh api --help`: "The default HTTP request method is GET
        #     normally and POST if any parameters were added." Treating
        #     any field-passing `gh api` as mutating closes the implicit-
        #     POST bypass.
        #   - gh pr (comment|review|create|close|reopen|ready|merge)
        #   - gh issue (create|comment|close|reopen)
        #   - gh release (create|edit|delete)
        #   - hub pull-request / hub issue / hub release / hub api — the
        #     legacy GitHub CLI that pre-dates `gh` but still works
        #   - curl -X POST/PATCH/PUT/DELETE against api.github.com endpoints
        #     that post: /comments, /issues, /pulls, /releases, /reviews
        #   - oss-autopilot or cli.bundle.cjs invoked with post or claim.
        #     The sub-pattern (^|[[:space:]]) ... ([[:space:]]|$) avoids
        #     false-positives on names like `oss-autopilot-post-processor`.
        if printf '%s' "$normalized" | grep -qE \
            '(gh[[:space:]]+api[^|&;]*(-X[[:space:]]*(POST|PATCH|PUT|DELETE)|--method[[:space:]]+(POST|PATCH|PUT|DELETE)|-XPOST|-XPATCH|-XPUT|-XDELETE))|(gh[[:space:]]+api[^|&;]*([[:space:]]|^)(-f|-F|--field|--raw-field)[[:space:]])|(gh[[:space:]]+pr[[:space:]]+(comment|review|create|close|reopen|ready|merge|edit))|(gh[[:space:]]+issue[[:space:]]+(create|comment|close|reopen))|(gh[[:space:]]+release[[:space:]]+(create|edit|delete))|(gh[[:space:]]+repo[[:space:]]+(create|delete|fork|edit|transfer))|(gh[[:space:]]+gist[[:space:]]+(create|edit|delete))|(hub[[:space:]]+(pull-request|issue|release|api))|(curl[[:space:]][^|&;]*-X[[:space:]]*(POST|PATCH|PUT|DELETE)[^|&;]*api\.github\.com/[^[:space:]|&;]*(comments|issues|pulls|releases|reviews))|((^|[[:space:]])(oss-autopilot|cli\.bundle\.cjs)[[:space:]][^|&;]*[[:space:]](post|claim)([[:space:]]|$))|((^|[[:space:]])(oss-autopilot|cli\.bundle\.cjs)[[:space:]](post|claim)([[:space:]]|$))'; then
            emit_ask "This command produces a public GitHub event (post / merge / close / create / release). Draft the content and present it to the user before running. The user must explicitly approve each external post per the global CLAUDE.md rule."
            exit 0
        fi
        ;;

    mcp__plugin_oss-autopilot_oss-autopilot__post|mcp__plugin_oss-autopilot_oss-autopilot__claim)
        # These MCP tools always post a public comment — ask unconditionally.
        emit_ask "The '${tool_name}' MCP tool writes a public GitHub comment under the user's identity. Show the user the exact body via the draft-review-post skill and wait for explicit approval before invoking."
        exit 0
        ;;

    mcp__github__*)
        # GitHub MCP server family (#1260). The matcher in hooks.json is an
        # explicit alternation of mutating tools — every entry here produces
        # an externally-visible event. Read-only tools (list_issues,
        # get_pull_request, search_*, etc.) are intentionally NOT in the
        # matcher and never reach this branch.
        emit_ask "The '${tool_name}' MCP tool produces a public GitHub event (post / merge / close / create / push / fork / delete) under the user's identity. Show the user what will happen and wait for explicit approval before invoking. See draft-review-post for the canonical approval flow."
        exit 0
        ;;

    *)
        # Other tool names — no guard for this hook.
        ;;
esac

exit 0

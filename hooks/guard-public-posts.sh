#!/usr/bin/env bash
# PreToolUse hook: intercept any tool call that posts publicly to GitHub or
# otherwise produces an externally-visible event (create/merge/close PRs,
# create/close issues, create releases, invoke MCP `post` / `claim`).
# Returns "ask" so Claude Code prompts the user for approval; does NOT
# block silently.
#
# This hook is wired to two PreToolUse matchers in hooks.json:
#   - Bash — inspects `tool_input.command` against a regex of gh/CLI patterns
#   - mcp__plugin_oss-autopilot_oss-autopilot__(post|claim) and
#     mcp__github__.* — the github MCP family is matched BROADLY (#1455) so
#     this script sees every github tool call; the read-only exclusion list
#     below decides which ones pass silently. A new mutating github-MCP
#     tool therefore defaults to the ask gate (fail-closed) instead of
#     silently bypassing a hand-maintained enumeration.
#
# Drift-resistance: `packages/mcp-server/src/tools.test.ts`
# (`describe('hooks.json guard-public-posts matcher (#1302 item 2)')`)
# pins the matcher's plugin-tool list to the tool registry's
# `destructiveHint` annotations. Adding a new tool with `destructiveHint:
# true` that posts publicly without updating the matcher fails CI; an
# explicit exclusion list covers the LOCAL_ONLY_DESTRUCTIVE case. The same
# suite pins the broad `mcp__github__.*` matcher entry (#1455).
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
    # NEVER emit `updatedInput` here. Claude Code treats a present
    # updatedInput as a WHOLESALE REPLACEMENT of the tool input, so an empty
    # object wipes the original parameters and the gated call fails schema
    # validation ("required parameter `command` is missing") instead of
    # prompting the user. The ask payload carries only hookEventName and
    # permissionDecision.
    #
    # Use jq -n when possible so future dynamic messages get proper JSON
    # escaping for free. Falls back to a handcrafted heredoc if jq is
    # broken (very unlikely by the time we reach this path — we check
    # for jq at startup below).
    if command -v jq >/dev/null 2>&1; then
        jq -nc --arg msg "$1" '{
          hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "ask"},
          systemMessage: $msg
        }'
    else
        # If jq is missing, we already emit a loud ask from the startup
        # check below; this branch is a last-resort fallback.
        cat <<EOF
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask"},"systemMessage":"guard-public-posts: refusing to parse tool input without jq. Install jq and retry."}
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

# --- Own-repo trust (opt-in, default off) ------------------------------------
# The guard exists to stop unattended posts into repos owned by *other* people.
# A user who also maintains their own repos hits the same gate on every
# `gh pr merge` / `gh issue close` against their own work, where there is no
# maintainer to show a draft to. `config.trustOwnRepoWrites` lets those through
# when the target repo is owned by the configured `githubUsername`.
#
# Every path that cannot PROVE the target is owned by that user falls back to
# the ask: feature off, no username configured, non-repo-scoped command, more
# than one target, chained/substituted commands, an unresolvable target, or a
# fork (where `gh pr create` targets the parent — someone else's repo — by
# default). Fail-closed is the whole point; a missed ask is a public post.
# Config source. Under `persistence: gist` the authoritative copy is the gist
# mirror (state-cache.json) and state.json is a stale local leftover; under
# local persistence it's the other way round. Reading the mode to decide is
# circular — it lives in the file being chosen — so take whichever was written
# last. Reading only state.json is what made an enabled trustOwnRepoWrites look
# unset on gist-backed setups.
state_file() {
    local local_state="${HOME}/.oss-autopilot/state.json"
    local gist_cache="${HOME}/.oss-autopilot/state-cache.json"
    [ -f "$gist_cache" ] || { printf '%s' "$local_state"; return 0; }
    [ -f "$local_state" ] || { printf '%s' "$gist_cache"; return 0; }
    if [ "$gist_cache" -nt "$local_state" ]; then
        printf '%s' "$gist_cache"
    else
        printf '%s' "$local_state"
    fi
}

read_config() {
    local key="$1" default="$2" file
    file=$(state_file)
    [ -f "$file" ] || { printf '%s' "$default"; return 0; }
    jq -r --arg d "$default" ".config.${key} // \$d" "$file" 2>/dev/null || printf '%s' "$default"
}

# Owner whose repos may be written without an ask. Empty output means "ask
# about everything" — the default.
trusted_owner() {
    [ "$(read_config trustOwnRepoWrites false)" = "true" ] || return 0
    read_config githubUsername ""
}

# Target repo of a `gh` invocation as owner/repo, or empty when it cannot be
# resolved unambiguously. Mirrors gh's own precedence: an explicit -R/--repo
# flag wins, otherwise the repo the cwd belongs to.
gh_target_repo() {
    local cmd="$1" cwd="$2" flags count
    flags=$(printf '%s\n' "$cmd" | grep -oE '(^|[[:space:]])(-R|--repo)[[:space:]]+[^[:space:]]+' | awk '{print $NF}')
    count=$(printf '%s' "$flags" | grep -c '[^[:space:]]' 2>/dev/null || true)
    if [ "${count:-0}" -gt 1 ]; then return 0; fi
    if [ "${count:-0}" -eq 1 ]; then printf '%s' "$flags"; return 0; fi
    [ -n "$cwd" ] && [ -d "$cwd" ] || return 0
    # `select(.parent == null)` prints nothing for a fork, so a fork checkout
    # resolves to "unknown" and keeps the ask.
    (cd "$cwd" && gh repo view --json nameWithOwner,parent -q 'select(.parent == null) | .nameWithOwner' 2>/dev/null) || true
}

# True when this Bash command writes only to a repo owned by the trusted user.
own_repo_write() {
    local cmd="$1" cwd="$2" owner target
    owner=$(trusted_owner)
    [ -n "$owner" ] || return 1
    # Only repo-scoped verbs can be attributed to a single target repo.
    # Account-level commands (`gh repo create`, `gh gist`), `hub`, raw curl and
    # the oss-autopilot CLI keep asking unconditionally.
    printf '%s' "$cmd" | grep -qE 'gh[[:space:]]+(pr|issue|release)[[:space:]]' || return 1
    # Chaining or substitution can hide a second, untrusted target in the same
    # invocation; the static analysis here only describes one command.
    case "$cmd" in *';'*|*'&&'*|*'||'*|*'|'*|*'$('*|*'`'*) return 1 ;; esac
    target=$(gh_target_repo "$cmd" "$cwd")
    [ -n "$target" ] || return 1
    [ "${target%%/*}" = "$owner" ]
}

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
            if own_repo_write "$normalized" "$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null || true)"; then
                exit 0
            fi
            emit_ask "This command produces a public GitHub event (post / merge / close / create / release). Draft the content and present it to the user before running. The user must explicitly approve each external post per the global CLAUDE.md rule."
            exit 0
        fi
        ;;

    mcp__plugin_oss-autopilot_oss-autopilot__post|mcp__plugin_oss-autopilot_oss-autopilot__claim)
        # These MCP tools always post a public comment — ask unconditionally.
        emit_ask "The '${tool_name}' MCP tool writes a public GitHub comment under the user's identity. Show the user the exact body via the draft-review-post skill and wait for explicit approval before invoking."
        exit 0
        ;;

    mcp__github__get_*|mcp__github__list_*|mcp__github__search_*|mcp__github__issue_read|mcp__github__pull_request_read)
        # Read-only github MCP tools — they produce no externally-visible
        # event. This exclusion list is the ONLY way a github MCP tool gets
        # through without an ask (#1455); keep it strictly read-only.
        exit 0
        ;;

    mcp__github__*)
        # GitHub MCP server family (#1260, #1455). The matcher in hooks.json
        # is the broad `mcp__github__.*`, so every github tool call reaches
        # this script. Anything not in the read-only exclusion list above is
        # treated as mutating — including tools that did not exist when this
        # guard was written (fail-closed).
        #
        # These tools name their target repo in a structured `owner` argument,
        # so own-repo trust needs no parsing here. Tools with no `owner` (e.g.
        # create_repository) never match and keep asking.
        mcp_owner=$(printf '%s' "$input" | jq -r '.tool_input.owner // empty' 2>/dev/null || true)
        trusted=$(trusted_owner)
        if [ -n "$trusted" ] && [ -n "$mcp_owner" ] && [ "$mcp_owner" = "$trusted" ]; then
            exit 0
        fi
        emit_ask "The '${tool_name}' MCP tool produces a public GitHub event (post / merge / close / create / push / fork / delete) under the user's identity. Show the user what will happen and wait for explicit approval before invoking. See draft-review-post for the canonical approval flow."
        exit 0
        ;;

    *)
        # Other tool names — no guard for this hook.
        ;;
esac

exit 0

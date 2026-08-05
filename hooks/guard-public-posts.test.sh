#!/usr/bin/env bash
# Test harness for guard-public-posts.sh.
#
# Run via: bash hooks/guard-public-posts.test.sh
# Exits 0 on success, 1 on first failure.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
SUBJECT="${SCRIPT_DIR}/guard-public-posts.sh"

if [ ! -x "$SUBJECT" ]; then
    echo "FAIL: subject not executable: $SUBJECT"
    exit 1
fi

PASS=0
FAIL=0

# Every case runs against a fixture HOME so the developer's own
# ~/.oss-autopilot/state.json can never change what these tests assert.
# TEST_HOME defaults to a config-less dir, i.e. own-repo trust off.
FIXTURE_ROOT=$(mktemp -d)
trap 'rm -rf "$FIXTURE_ROOT"' EXIT

# make_home <name> <state-json-config-object|"">  → prints the HOME path
make_home() {
    local name="$1" config="$2" home="${FIXTURE_ROOT}/$1"
    mkdir -p "${home}/.oss-autopilot"
    if [ -n "$config" ]; then
        printf '{"config":%s}' "$config" > "${home}/.oss-autopilot/state.json"
    fi
    printf '%s' "$home"
}

HOME_NO_CONFIG=$(make_home no-config '')
HOME_TRUST_OFF=$(make_home trust-off '{"githubUsername":"octocat","trustOwnRepoWrites":false}')
HOME_TRUST_ON=$(make_home trust-on '{"githubUsername":"octocat","trustOwnRepoWrites":true}')
HOME_TRUST_ON_NO_USER=$(make_home trust-on-no-user '{"trustOwnRepoWrites":true}')
TEST_HOME="$HOME_NO_CONFIG"

pass() {
    echo "  PASS: $1"
    PASS=$((PASS + 1))
}

fail() {
    echo "  FAIL: $1: $2"
    FAIL=$((FAIL + 1))
}

# expect_ask <case-name> <stdin-json>
expect_ask() {
    local name="$1"
    local payload="$2"
    local out
    out=$(printf '%s' "$payload" | HOME="$TEST_HOME" "$SUBJECT" 2>/dev/null)
    # Accept both compact and pretty-printed JSON shapes.
    if ! echo "$out" | grep -qE '"permissionDecision"[[:space:]]*:[[:space:]]*"ask"'; then
        fail "$name" "expected ask decision; got: $out"
        return
    fi
    # Claude Code discards the whole hookSpecificOutput block when
    # hookEventName is absent, so an "ask" without it silently allows the
    # post. Assert the field is present or the guard is decorative.
    if echo "$out" | grep -qE '"hookEventName"[[:space:]]*:[[:space:]]*"PreToolUse"'; then
        pass "$name"
    else
        fail "$name" "ask decision is missing hookEventName; got: $out"
    fi
}

# expect_allow <case-name> <stdin-json>  — passes when the hook emits no output
# (exit 0, empty stdout) which Claude Code treats as "no opinion / allow".
expect_allow() {
    local name="$1"
    local payload="$2"
    local out
    out=$(printf '%s' "$payload" | HOME="$TEST_HOME" "$SUBJECT" 2>/dev/null)
    if [ -z "$out" ]; then
        pass "$name"
    else
        fail "$name" "expected no-op (allow); got: $out"
    fi
}

# Helper to build a Bash tool_input payload.
bash_payload() {
    local cmd="$1"
    printf '{"tool_name":"Bash","tool_input":{"command":%s}}' "$(jq -Rn --arg c "$cmd" '$c')"
}

# Helper to build a Bash payload with the cwd Claude Code reports.
bash_payload_cwd() {
    local cmd="$1" cwd="$2"
    printf '{"tool_name":"Bash","tool_input":{"command":%s},"cwd":%s}' \
        "$(jq -Rn --arg c "$cmd" '$c')" "$(jq -Rn --arg d "$cwd" '$d')"
}

# Helper to build an MCP tool payload.
mcp_payload() {
    local tool="$1"
    printf '{"tool_name":%s,"tool_input":{}}' "$(jq -Rn --arg t "$tool" '$t')"
}

# Helper to build an MCP tool payload carrying a target repo owner.
mcp_payload_owner() {
    local tool="$1" owner="$2"
    printf '{"tool_name":%s,"tool_input":{"owner":%s,"repo":"dash"}}' \
        "$(jq -Rn --arg t "$tool" '$t')" "$(jq -Rn --arg o "$owner" '$o')"
}

echo "Running guard-public-posts.sh tests..."

# ── Existing (regression) cases ───────────────────────────────────────
expect_ask  "gh pr comment is guarded"        "$(bash_payload 'gh pr comment 123 --body hi')"
expect_ask  "gh issue comment is guarded"     "$(bash_payload 'gh issue comment 456 --body hi')"
expect_ask  "gh pr review is guarded"         "$(bash_payload 'gh pr review 789 --approve')"
expect_ask  "cli.bundle.cjs post is guarded"  "$(bash_payload 'node cli.bundle.cjs post https://github.com/o/r/issues/1 hi')"

# ── Newly covered Bash bypasses (#1032) ───────────────────────────────
expect_ask  "gh api POST is guarded"          "$(bash_payload 'gh api -X POST repos/o/r/issues/1/comments -f body=hi')"
expect_ask  "gh api --method POST is guarded" "$(bash_payload 'gh api --method POST repos/o/r/issues/1/comments')"
expect_ask  "gh api -XPOST is guarded"        "$(bash_payload 'gh api -XPOST repos/o/r/issues/1/comments')"
# Implicit POST: `gh api` auto-POSTs whenever -f/-F/--field is supplied.
expect_ask  "gh api -f implicit-POST is guarded"      "$(bash_payload 'gh api repos/o/r/issues/1/comments -f body=hi')"
expect_ask  "gh api -F implicit-POST is guarded"      "$(bash_payload 'gh api repos/o/r/issues/1/comments -F body=hi')"
expect_ask  "gh api --field implicit-POST is guarded" "$(bash_payload 'gh api repos/o/r/issues/1/comments --field body=hi')"
expect_ask  "gh api --raw-field implicit-POST is guarded" "$(bash_payload 'gh api repos/o/r/issues/1/comments --raw-field body=hi')"
expect_ask  "gh pr merge is guarded"          "$(bash_payload 'gh pr merge 123 --squash')"
expect_ask  "gh pr create is guarded"         "$(bash_payload 'gh pr create --title X --body Y')"
expect_ask  "gh pr close is guarded"          "$(bash_payload 'gh pr close 123')"
expect_ask  "gh pr reopen is guarded"         "$(bash_payload 'gh pr reopen 123')"
expect_ask  "gh pr ready is guarded"          "$(bash_payload 'gh pr ready 123')"
expect_ask  "gh issue create is guarded"      "$(bash_payload 'gh issue create --title X --body Y')"
expect_ask  "gh issue close is guarded"       "$(bash_payload 'gh issue close 123')"
expect_ask  "gh release create is guarded"    "$(bash_payload 'gh release create v1.0.0')"
expect_ask  "gh release edit is guarded"      "$(bash_payload 'gh release edit v1.0.0 --draft=false')"
expect_ask  "oss-autopilot post is guarded"   "$(bash_payload 'oss-autopilot post https://github.com/o/r/issues/1 hi')"
expect_ask  "oss-autopilot claim is guarded"  "$(bash_payload 'oss-autopilot claim https://github.com/o/r/issues/1')"

# ── New `gh` subcommand coverage (#1260) ──────────────────────────────
expect_ask  "gh pr edit is guarded"           "$(bash_payload 'gh pr edit 123 --body new-body')"
expect_ask  "gh repo create is guarded"       "$(bash_payload 'gh repo create newrepo --public')"
expect_ask  "gh repo delete is guarded"       "$(bash_payload 'gh repo delete owner/repo --yes')"
expect_ask  "gh repo fork is guarded"         "$(bash_payload 'gh repo fork owner/repo')"
expect_ask  "gh repo edit is guarded"         "$(bash_payload 'gh repo edit owner/repo --description X')"
expect_ask  "gh gist create is guarded"       "$(bash_payload 'gh gist create file.txt --public')"
expect_ask  "gh gist edit is guarded"         "$(bash_payload 'gh gist edit abc123')"
expect_ask  "gh gist delete is guarded"       "$(bash_payload 'gh gist delete abc123 --yes')"

expect_allow "gh repo view is not guarded"    "$(bash_payload 'gh repo view owner/repo')"
expect_allow "gh repo list is not guarded"    "$(bash_payload 'gh repo list owner')"
expect_allow "gh gist list is not guarded"    "$(bash_payload 'gh gist list')"
expect_allow "gh gist view is not guarded"    "$(bash_payload 'gh gist view abc123')"

# ── GitHub MCP family (#1260, #1455) ──────────────────────────────────
# The hooks.json matcher is the broad `mcp__github__.*`, so EVERY github
# MCP tool call reaches this script. Mutating tools (and any tool not in
# the read-only exclusion list, including future ones) get the ASK;
# read-only tools pass silently.
expect_ask  "MCP github add_issue_comment is guarded"          "$(mcp_payload 'mcp__github__add_issue_comment')"
expect_ask  "MCP github create_pull_request is guarded"        "$(mcp_payload 'mcp__github__create_pull_request')"
expect_ask  "MCP github merge_pull_request is guarded"         "$(mcp_payload 'mcp__github__merge_pull_request')"
expect_ask  "MCP github issue_write is guarded"                "$(mcp_payload 'mcp__github__issue_write')"
expect_ask  "MCP github push_files is guarded"                 "$(mcp_payload 'mcp__github__push_files')"
expect_ask  "MCP github fork_repository is guarded"            "$(mcp_payload 'mcp__github__fork_repository')"
expect_ask  "MCP github delete_file is guarded"                "$(mcp_payload 'mcp__github__delete_file')"

# Fail-closed: a github MCP tool this guard has never heard of must ASK,
# not pass — new mutating tools are covered without editing this script.
expect_ask  "MCP github unknown future tool is guarded (fail-closed)" \
            "$(mcp_payload 'mcp__github__brand_new_mutating_tool')"

# Read-only github MCP tools pass through silently (exclusion list, #1455).
expect_allow "MCP github get_me is not guarded"                "$(mcp_payload 'mcp__github__get_me')"
expect_allow "MCP github get_file_contents is not guarded"     "$(mcp_payload 'mcp__github__get_file_contents')"
expect_allow "MCP github list_issues is not guarded"           "$(mcp_payload 'mcp__github__list_issues')"
expect_allow "MCP github list_pull_requests is not guarded"    "$(mcp_payload 'mcp__github__list_pull_requests')"
expect_allow "MCP github search_code is not guarded"           "$(mcp_payload 'mcp__github__search_code')"
expect_allow "MCP github search_issues is not guarded"         "$(mcp_payload 'mcp__github__search_issues')"
expect_allow "MCP github issue_read is not guarded"            "$(mcp_payload 'mcp__github__issue_read')"
expect_allow "MCP github pull_request_read is not guarded"     "$(mcp_payload 'mcp__github__pull_request_read')"

# Silent-failure hunter regression tests — real bypasses addressed in this PR.
expect_ask  "hub pull-request is guarded"     "$(bash_payload 'hub pull-request -m title')"
expect_ask  "hub issue is guarded"            "$(bash_payload 'hub issue create -m title')"
expect_ask  "hub release is guarded"          "$(bash_payload 'hub release create v1')"
expect_ask  "curl -X POST to api.github.com/issues/comments is guarded" \
            "$(bash_payload 'curl -X POST -H auth https://api.github.com/repos/o/r/issues/1/comments -d body=hi')"
expect_ask  "curl -X PATCH to api.github.com/pulls is guarded" \
            "$(bash_payload 'curl -X PATCH https://api.github.com/repos/o/r/pulls/1 -d state=closed')"
expect_ask  "gh pr quoted verb is guarded (quotes stripped)" \
            "$(bash_payload "gh pr 'merge' 1")"
expect_ask  "gh pr double-quoted verb is guarded" \
            "$(bash_payload 'gh pr "merge" 1')"

# False-positive regression: lookalike commands must NOT be flagged.
expect_allow "oss-autopilot-post-processor is not guarded (word boundary)" \
             "$(bash_payload 'oss-autopilot-post-processor --run')"
expect_allow "npm run post-build is not guarded" \
             "$(bash_payload 'npm run post-build')"

# ── MCP tool matcher (#1032) ──────────────────────────────────────────
expect_ask  "MCP post tool is guarded"        "$(mcp_payload 'mcp__plugin_oss-autopilot_oss-autopilot__post')"
expect_ask  "MCP claim tool is guarded"       "$(mcp_payload 'mcp__plugin_oss-autopilot_oss-autopilot__claim')"

# ── Safe commands — must pass through untouched ───────────────────────
expect_allow "gh pr view is not guarded"      "$(bash_payload 'gh pr view 123')"
expect_allow "gh pr list is not guarded"      "$(bash_payload 'gh pr list')"
expect_allow "gh api GET is not guarded"      "$(bash_payload 'gh api user')"
expect_allow "gh issue view is not guarded"   "$(bash_payload 'gh issue view 123')"
expect_allow "npm install is not guarded"     "$(bash_payload 'npm install lodash')"
expect_allow "git commit is not guarded"      "$(bash_payload 'git commit -m chore: x')"

# ── Corrupt input must not crash ──────────────────────────────────────
expect_allow "malformed JSON stdin does not crash" 'not json at all {{{'
expect_allow "empty stdin does not crash"          ''
expect_allow "missing tool_name allows through"    '{}'

# ── Mutating MCP tools NOT scoped to this guard (they do not post) ────
expect_allow "MCP move tool is not guarded by this hook"   "$(mcp_payload 'mcp__plugin_oss-autopilot_oss-autopilot__move')"
expect_allow "MCP track tool is not guarded by this hook"  "$(mcp_payload 'mcp__plugin_oss-autopilot_oss-autopilot__track')"

# ── Own-repo trust (config.trustOwnRepoWrites) ────────────────────────
# Default off: identical commands keep asking until the user opts in.
TEST_HOME="$HOME_TRUST_OFF"
expect_ask  "own-repo write asks while trust is off" \
            "$(bash_payload 'gh pr merge 20 -R octocat/dash --squash')"

TEST_HOME="$HOME_TRUST_ON"
expect_allow "own-repo pr merge passes with -R"      "$(bash_payload 'gh pr merge 20 -R octocat/dash --squash')"
expect_allow "own-repo issue close passes with -R"   "$(bash_payload 'gh issue close 18 --repo octocat/dash')"
expect_allow "own-repo issue comment passes with -R" "$(bash_payload 'gh issue comment 18 --repo octocat/dash --body hi')"

# Everything the hook cannot prove is own-repo keeps asking.
expect_ask  "another owner still asks"               "$(bash_payload 'gh pr merge 20 -R someoneelse/dash --squash')"
expect_ask  "two -R targets still ask"               "$(bash_payload 'gh issue close 1 -R octocat/dash -R someoneelse/dash')"
expect_ask  "chained commands still ask"             "$(bash_payload 'gh issue close 1 -R octocat/dash && gh issue close 2 -R someoneelse/dash')"
expect_ask  "piped commands still ask"               "$(bash_payload 'gh issue list -R octocat/dash | gh issue close -R someoneelse/dash')"
expect_ask  "command substitution still asks"        "$(bash_payload 'gh pr merge $(cat n) -R octocat/dash')"
expect_ask  "account-level gh repo create still asks" "$(bash_payload 'gh repo create dash --public')"
expect_ask  "gh api still asks even for an own repo" "$(bash_payload 'gh api -X POST repos/octocat/dash/issues/1/comments -f body=hi')"
expect_ask  "oss-autopilot post still asks"          "$(bash_payload 'oss-autopilot post https://github.com/octocat/dash/issues/1 hi')"
# No -R: the target comes from the cwd's repo, and a cwd that resolves to
# nothing (not a checkout, or a fork whose parent is someone else's) asks.
expect_ask  "unresolvable cwd asks"                  "$(bash_payload_cwd 'gh pr merge 20 --squash' "${FIXTURE_ROOT}/not-a-repo")"
expect_ask  "missing cwd asks"                       "$(bash_payload 'gh pr merge 20 --squash')"

TEST_HOME="$HOME_TRUST_ON_NO_USER"
expect_ask  "trust on but no githubUsername asks"    "$(bash_payload 'gh pr merge 20 -R octocat/dash --squash')"

# The github MCP family names its target owner in tool_input.
TEST_HOME="$HOME_TRUST_ON"
expect_allow "MCP own-repo merge passes"             "$(mcp_payload_owner 'mcp__github__merge_pull_request' 'octocat')"
expect_ask   "MCP other-owner merge asks"            "$(mcp_payload_owner 'mcp__github__merge_pull_request' 'someoneelse')"
expect_ask   "MCP tool without an owner asks"        "$(mcp_payload 'mcp__github__create_repository')"
expect_ask   "MCP oss-autopilot post asks even for own repos" \
             "$(mcp_payload 'mcp__plugin_oss-autopilot_oss-autopilot__post')"

TEST_HOME="$HOME_TRUST_OFF"
expect_ask   "MCP own-repo merge asks while trust is off" \
             "$(mcp_payload_owner 'mcp__github__merge_pull_request' 'octocat')"

TEST_HOME="$HOME_NO_CONFIG"

echo
echo "Results: ${PASS} passed, ${FAIL} failed."
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
exit 0

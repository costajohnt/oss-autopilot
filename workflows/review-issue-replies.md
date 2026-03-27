# Review Issue Replies

> **Session state:** Expects `data.daily.commentedIssues` from core router.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Handle Review Issue Replies

First, filter `data.daily.commentedIssues` to entries with `status === 'new_response'`. **If the filtered list is empty** (no issues, undefined, or all already reviewed), inform the user: "No new issue replies to review." Then return to the core router (`commands/oss.md`) — **After Each Action** section.

When there are issues to review, display each one:

```
## Issue Replies

Maintainers responded to your comments on these issues:

1. **owner/repo#123** — Issue title
   https://github.com/owner/repo/issues/123
   └─ @maintainer: "Go for it! Feel free to submit a PR..."
   └─ Your comment: 5 days ago

2. **owner/repo#456** — Another issue title
   https://github.com/owner/repo/issues/456
   └─ @maintainer: "Thanks for the interest. Here's what..."
   └─ Your comment: 2 days ago
```

For each issue, use AskUserQuestion to offer actions:
- "Start working on this issue" — Dismiss the issue reply by running `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. Then set `isNewContribution = true` and `issueContext = { title, url, description }` from the issue data, and return to the core router (`commands/oss.md`) — the Pre-Commit Review routing will direct to the draft-first workflow. Do NOT post a claim comment on the issue; the PR will be the first interaction. If the dismiss fails, show the error but still proceed to the implementation flow.
- "Mark as reviewed" — The user has seen the reply but doesn't want to work on the issue right now. Dismiss it so it won't reappear next session: run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. If a genuinely new response arrives later (after the dismiss timestamp), the auto-undismiss logic will resurface it.
- "View full thread" — Display the issue URL for the user to open in browser. After viewing, re-prompt with the same options for this issue (do not advance to the next issue).
- "Skip" — Leave the reply undismissed. It will reappear next session. Use this when the user wants to defer action to a future session.
- "Done for now" — End session with summary. Routes to Session End in the core router.

**Error handling:** If any CLI command (`dismiss`) returns `{ success: false }`, show the `error` field to the user and skip the remaining steps for that issue. Offer to retry or skip to the next issue.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (which will return to Action Menu since no Tier 1/2 actions were taken).

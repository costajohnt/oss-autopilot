# Review Issue Replies

> **Session state:** Expects `data.daily.commentedIssues` from core router.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Handle Review Issue Replies

First, filter `data.daily.commentedIssues` to entries with `status === 'new_response'`. **If the filtered list is empty** (no issues, undefined, or all already reviewed), inform the user: "No new issue replies to review." Then return to the core router (`commands/oss.md`) — **After Each Action** section.

When there are issues to review, display each one with the user's original comment alongside the maintainer's reply so the thread stays readable in context (#1290). Both bodies are pre-truncated to 200 chars by the data layer.

```
## Issue Replies

Maintainers responded to your comments on these issues:

1. **owner/repo#123** — Issue title
   https://github.com/owner/repo/issues/123

   You commented 5 days ago:
   > {data.userLastCommentBody}

   @{data.lastResponseAuthor} replied:
   > {data.lastResponseBody}

2. **owner/repo#456** — Another issue title
   https://github.com/owner/repo/issues/456

   You commented 2 days ago:
   > {data.userLastCommentBody}

   @{data.lastResponseAuthor} replied:
   > {data.lastResponseBody}
```

Both `userLastCommentBody` and `lastResponseBody` are present on every `new_response` entry. If a body is empty (rare; e.g. a comment that was edited to blank), render `> _(no text)_` instead of an empty quote line.

For each issue, use AskUserQuestion to offer actions:
- "Start working on this issue" — Dismiss the issue reply by running `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. Then set `isNewContribution = true` and `issueContext = { title, url, description }` from the issue data, and return to the core router (`commands/oss.md`) — the Pre-Commit Review routing will direct to the draft-first workflow. Do NOT post a claim comment on the issue; the PR will be the first interaction. If the dismiss fails, show the error but still proceed to the implementation flow.
- "Reply with a question" — Draft a follow-up comment to ask for clarification before deciding (#1290 step 3). See **Drafting a clarifying reply** below. Routes through the `draft-review-post` skill — saves the draft to `/tmp/claude-drafts/...` and hands the user the `gh issue comment` command. **Never auto-post.** Do NOT dismiss the issue afterward — a pending question means the issue should reappear next session if the maintainer hasn't replied yet. After the draft is saved, re-prompt with the same actions for this issue (the user may then mark-as-reviewed, skip, or pick another action).
- "Mark as reviewed" — The user has seen the reply but doesn't want to work on the issue right now. Dismiss it so it won't reappear next session: run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. If a genuinely new response arrives later (after the dismiss timestamp), the auto-undismiss logic will resurface it.
- "View full thread" — Display the issue URL for the user to open in browser. After viewing, re-prompt with the same options for this issue (do not advance to the next issue).
- "Skip" — Leave the reply undismissed. It will reappear next session. Use this when the user wants to defer action to a future session.
- "Done for now" — End session with summary. Routes to Session End in the core router.

### Drafting a clarifying reply

When the user picks "Reply with a question":

1. **Surface context first.** Re-display the user's original comment and the maintainer's reply (the `userLastCommentBody` / `lastResponseBody` already shown above) so the user has both visible while composing the question.
2. **Prompt for the question text.** Use a free-form input ("What do you want to ask?"). Keep it short — clarifying questions are typically 1–2 sentences. Discourage rehashing the original comment; the maintainer can scroll up.
3. **Route through `draft-review-post`.** Pass the question text, target URL (`{data.url}`), and a hint that this is an issue comment (not a PR comment) so the skill emits the correct `gh issue comment {URL} --body-file ...` command.
4. **Do NOT dismiss the issue.** The issue stays in the next session's `commentedIssues` so the user is reminded if the maintainer hasn't replied yet. Auto-undismiss handles the case where the maintainer answers the follow-up.
5. **Re-prompt for this same issue** with the standard action list above. The user can then mark-as-reviewed, skip, or pick a different action — the question is in their drafts folder either way.

**Tone constraints** for the drafted question (mirror the dormant-pr-follow-up rules):
- 1–2 sentences max.
- No sycophancy ("Thanks so much for your detailed reply!") or formulaic openings.
- No restating what the maintainer already said.
- No AI attribution.

**Error handling:** If any CLI command (`dismiss`) returns `{ success: false }`, show the `error` field to the user and skip the remaining steps for that issue. Offer to retry or skip to the next issue.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (which will return to Action Menu since no Tier 1/2 actions were taken).

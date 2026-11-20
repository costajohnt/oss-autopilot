# Review Issue Replies

> **Session state:** Expects `data.daily.commentedIssues` from core router.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Handle Review Issue Replies

First, filter `data.daily.commentedIssues` to entries with `status === 'new_response'`. **If the filtered list is empty** (no issues, undefined, or all already reviewed), inform the user: "No new issue replies to review." Then return to the core router (`commands/oss.md`) — **After Each Action** section.

Two kinds of entry arrive here (#1862), told apart by the optional `engagement` field:

- **Engaged issues** (`engagement` present): the user claimed the issue (`reason: 'claim'`) or one of their PRs links it (`reason: 'open_pr' | 'closed_pr' | 'merged_pr'`, with `prUrl`). Any substantive non-bot comment after the user's last word counts as a reply here, so `lastResponseAuthor` may be a community member without a maintainer role or an @mention. Label these "Reply on an issue you're working on".
- **Passing comments** (no `engagement`): the user only commented. The reply is from a maintainer (`isFromMaintainer: true`), @mentions the user, or quotes their comment. Label these "Maintainer replied" or "Reply to your comment".

When there are issues to review, display each one (`issue` below is one filtered entry) with the user's original comment alongside the reply so the thread stays readable in context (#1290). Both bodies are pre-truncated to 200 chars by the data layer.

```
## Issue Replies

Replies on issues you commented on or are working on:

1. **owner/repo#123** — Issue title   [Reply on an issue you're working on: PR #50]
   https://github.com/owner/repo/issues/123

   You commented 5 days ago:
   > {issue.userLastCommentBody}

   @{issue.lastResponseAuthor} replied:
   > {issue.lastResponseBody}

2. **owner/repo#456** — Another issue title   [Maintainer replied]
   https://github.com/owner/repo/issues/456

   You commented 2 days ago:
   > {issue.userLastCommentBody}

   @{issue.lastResponseAuthor} replied:
   > {issue.lastResponseBody}
```

The bracketed label comes from `engagement` (name the PR number from `engagement.prUrl` when there is one; "claimed" for `reason: 'claim'`) or, without it, from `isFromMaintainer` ("Maintainer replied" / "Reply to your comment").

Both `userLastCommentBody` and `lastResponseBody` are present on every `new_response` entry. If a body is empty (rare; e.g. a comment that was edited to blank), render `> _(no text)_` instead of an empty quote line. On an engaged issue the user never commented on, `userLastCommentBody` is empty and `userLastCommentedAt` is the engagement time: replace the "You commented N days ago" line with "You opened {engagement.prUrl} N days ago" (or "You claimed this issue N days ago") and omit the quote.

For each issue, use AskUserQuestion to offer actions:
- "Start working on this issue" — Dismiss the issue reply by running `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. Then set `isNewContribution = true` and `issueContext = { title, url, description }` from the issue data, and return to the core router (`commands/oss.md`) — the Pre-Commit Review routing will direct to the draft-first workflow. Do NOT post a claim comment on the issue; the PR will be the first interaction. If the dismiss fails, show the error but still proceed to the implementation flow. Skip offering this on an engaged issue with `reason: 'open_pr'` (the user is already working on it through that PR); offer "Reply" instead.
- "Reply with a question" — Draft a follow-up comment to ask for clarification before deciding (#1290 step 3). See **Drafting a clarifying reply** below. Stages the reply in the tool's own draft directory and posts it with `post --body-file ... --expect-sha256` only after the user approves the exact text. **Never auto-post.** Do NOT dismiss the issue afterward — a pending question means the issue should reappear next session if the maintainer hasn't replied yet. After the reply is posted (or the user drops it), re-prompt with the same actions for this issue (the user may then mark-as-reviewed, skip, or pick another action). On an engaged issue the reply usually argues with or confirms the user's plan; a short answer that says what the user will do (or that the PR already handles it) is the right shape, same drafting rules.
- "Mark as reviewed" — The user has seen the reply but doesn't want to work on the issue right now. Dismiss it so it won't reappear next session: run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss ISSUE_URL --json`. If a genuinely new response arrives later (after the dismiss timestamp), the auto-undismiss logic will resurface it, under the same rule that surfaced this one (so a later community reply on an engaged issue comes back too).
- "View full thread" — Display the issue URL for the user to open in browser. After viewing, re-prompt with the same options for this issue (do not advance to the next issue).
- "Skip" — Leave the reply undismissed. It will reappear next session. Use this when the user wants to defer action to a future session.
- "Done for now" — End session with summary. Routes to Session End in the core router.

### Drafting a clarifying reply

When the user picks "Reply with a question":

1. **Surface context first.** Re-display the user's original comment and the maintainer's reply (the `userLastCommentBody` / `lastResponseBody` already shown above) so the user has both visible while composing the question.
2. **Prompt for the question text.** Apply "Before drafting a comment" (`workflows/reference.md`) for the issue's repo first: when it says hand off, draft nothing for this issue, tell the user why, and move on. Otherwise use a free-form input ("What do you want to ask?"). Keep it short — clarifying questions are typically 1–2 sentences. Discourage rehashing the original comment; the maintainer can scroll up.
3. **Stage the draft and post only after approval** (the flow in "Draft Files", `workflows/reference.md`; never under `/tmp`, never as a shell argument):
   1. Get a draft path (`<unix-ts>` from `date +%s`) and save the question to the printed path **with the Write tool** (use the path literally and quoted):
      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" draft path <owner>--<repo>-<issue-number>-reply-<unix-ts>.md
      ```
   2. Read it back once:
      ```bash
      node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" draft show "<draft-path>" --json
      ```
      Show the user `data.content`, complete, inside a code fence longer than any run of backticks in it; `data.sha256` is the hash of exactly that text (`<sha256>` below). Ask for approval as in "Approval to post" (`workflows/reference.md`): an AskUserQuestion with Post this comment / Edit before posting / Don't post. After an edit, rerun `draft show` and show the new text (write the file again only when the user dictated the change in chat).
   3. Only on a "Post this comment" answer that passes those rules, post it:
      ```bash
      GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" post {issue.url} --body-file "<draft-path>" --expect-sha256 <sha256> --json
      ```
      **Never post without that approval.** If it returns `{ success: false }`, show the `error` field and keep the draft; a hash mismatch means the file changed since the user saw it, so go back to step 2.
   4. On `success: true`, delete the draft (`rm -- "<draft-path>"`). Delete it too when the user decides not to post.
4. **Do NOT dismiss the issue.** The issue stays in the next session's `commentedIssues` so the user is reminded if the maintainer hasn't replied yet. Auto-undismiss handles the case where the maintainer answers the follow-up.
5. **Re-prompt for this same issue** with the standard action list above. The user can then mark-as-reviewed, skip, or pick a different action.

**Tone constraints** for the drafted question (mirror the dormant-pr-follow-up rules):
- 1–2 sentences max.
- No sycophancy ("Thanks so much for your detailed reply!") or formulaic openings.
- No restating what the maintainer already said.
- No AI attribution.

**Error handling:** If any CLI command (`dismiss`, `post`) returns `{ success: false }`, show the `error` field to the user and skip the remaining steps for that issue (keep a draft that failed to post; a hash mismatch means it changed since the user saw it, so go back to `draft show`). Offer to retry or skip to the next issue.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (which will return to Action Menu since no Tier 1/2 actions were taken).

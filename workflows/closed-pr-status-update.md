# Closed-PR Status Update

> **Session state:** Expects `data.daily.closedPRStatusUpdates` from the core router (one entry per closed-unmerged PR whose linked issue has not heard from the user since the close: `prUrl`, `issueUrl`, `closedAt`).
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Trigger

The user picked `closed_pr_status` ("Post status update on linked issue (N)") from the action menu. The CLI only lists a PR here when (a) its body links an issue with a closing keyword, (b) no other PR of the user's (open or merged) links the same issue, and (c) the user has not commented on the issue since the PR closed. The local claim on each listed issue is already released; nothing here touches state.

## Why

When a contributor closes their own PR unmerged, the conclusion usually lives only in the PR thread. The linked issue still shows the contributor's "I'd like to work on this" as the latest word, so others keep treating it as claimed. One short comment on the issue fixes that.

## Steps

Handle entries one at a time, in `closedAt` order (oldest first).

1. **Read the PR's closing context.** Run `gh pr view {prUrl} --comments` and read the last comment the user left on the PR (usually the closing write-up) plus the PR title. If the user left no closing comment, read the final maintainer comment instead so the draft can say why the PR closed.

2. **Read the issue thread.** Run `gh issue view {issueUrl} --comments`. Confirm the thread does not already carry the outcome (the CLI checked for a comment by the user after `closedAt`, but a comment posted minutes before closing the PR would be missed). If the outcome is already there, tell the user and skip to the next entry.

3. **Draft the status comment.** Three parts, two to four sentences total:
   - What was found (from the closing write-up: bug no longer reproduces, scope was wrong, maintainer chose another direction, and so on).
   - That the PR is closed, with its URL.
   - Whether the user is stepping away from the issue, so others can pick it up. Ask the user with AskUserQuestion when the closing comment does not say ("Are you stepping away from this issue?" with options: stepping away, still planning another attempt).

   Tone constraints (mirror `workflows/dormant-pr-follow-up.md`): plain and factual, no apologies beyond one clause, no restating the issue, no AI attribution (see `skills/contribution-ethics/SKILL.md`).

4. **Route through `draft-review-post`.** Pass the comment text and the target URL (`{issueUrl}`), with a hint that this is an issue comment so the skill emits `gh issue comment {issueUrl} --body-file ...`. **Never post directly.** The skill saves the draft and waits for the user's approval; the user posts.

5. **Re-prompt for the next entry** until the list is exhausted, then return to the Action Menu.

## Scope

**In scope:** drafting one status comment per listed issue, routed through `draft-review-post`.

**Out of scope:** reopening the PR, re-claiming the issue, editing local state. If the user says they will make another attempt, do not re-claim here; the next `claim` on that issue records it again.

**Error handling:** If a `gh` read fails, show the error and offer to skip the entry. Once the user posts a comment, the entry drops out of the next daily run on its own; no manual dismiss exists or is needed.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (Tier 2: a comment was drafted; no Tier 1 actions were taken).

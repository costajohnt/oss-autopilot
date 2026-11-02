# Closed-PR Status Update

> **Session state:** Expects `data.daily.closedPRStatusUpdates` from the core router (one entry per closed-unmerged PR whose linked issue has not heard from the user since the close: `prUrl`, `issueUrl`, `closedAt`).
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Trigger

The user picked `closed_pr_status` ("Post status update on linked issue (N)") from the action menu. The CLI only lists a PR here when all of these hold:

- (a) its body links an issue with a closing keyword;
- (b) the user closed the PR themselves (a maintainer or bot close is never listed);
- (c) no other PR of the user's supersedes it: none open or merged that closes the same issue, and none open that mentions the issue or the closed PR anywhere in its title or body;
- (d) the user has not commented on the issue since the PR closed;
- (e) the user has not dismissed the issue URL at or after the close (see "Skip" below);
- (f) this run's PR fetch could not have missed a successor for it: the open-PR search was not truncated at the API's 1000-result cap, the recently-merged fetch succeeded, and no per-PR fetch in the closed PR's own repo failed. Otherwise the CLI withholds that PR (release and nudge) and records one warning under `closed-pr-status` naming each withheld PR URL and why, so a missing successor cannot be mistaken for an abandoned issue.

The local claim on each listed issue is released if it was tracked (`activeIssues`); see `warnings` entries under `closed-pr-status` for anything that did not go through. Releasing does not change capacity (capacity counts open PRs only): the issue simply stops reading as in progress and re-enters the commented-issue monitor from the next run. A claim recorded after the close is kept; the user re-claimed on purpose (`claim` refreshes the claim stamp on an issue that is already tracked). Nothing in this workflow touches state except the optional dismiss in "Skip".

## Why

When a contributor closes their own PR unmerged, the conclusion usually lives only in the PR thread. The linked issue still shows the contributor's "I'd like to work on this" as the latest word, so others keep treating it as claimed. One short comment on the issue fixes that.

## Steps

Handle entries one at a time, in `closedAt` order (oldest first).

1. **Read the PR's closing context.** Run `gh pr view {prUrl} --comments` and read the last comment the user left on the PR (usually the closing write-up) plus the PR title. If the user left no closing comment, read the final maintainer comment instead so the draft can say why the PR closed.

2. **Read the issue thread.** Run `gh issue view {issueUrl} --comments`. Confirm the thread does not already carry the outcome (the CLI checked for a comment by the user after `closedAt`, but a comment posted minutes before closing the PR would be missed). If the outcome is already there, tell the user and skip to the next entry. The CLI leaves issues listed in `closedPRStatusUpdates` out of "Review issue replies" only while they carry no new maintainer reply; an issue with a new reply stays listed there as well, since answering the maintainer is a separate ask from posting the status update.

3. **Ask what to do with this entry.** AskUserQuestion with three options:
   - **Draft the status comment** (default) — continue with step 4.
   - **Skip, don't ask again** — run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss {issueUrl} --json`. The dismiss timestamp lands after `closedAt`, which is exactly what the daily run checks, so the entry does not return. Tell the user the side effect: the same dismiss also mutes this issue under "Review issue replies" until someone posts there again (existing auto-undismiss). Move to the next entry.
   - **Defer** — leave everything as is; the entry returns next session until the user comments on the issue, dismisses it, or the PR leaves the 7-day window. Move to the next entry.

4. **Draft the status comment.** Three parts, two to four sentences total:
   - What was found (from the closing write-up: bug no longer reproduces, scope was wrong, maintainer chose another direction, and so on).
   - That the PR is closed, with its URL.
   - Whether the user is stepping away from the issue, so others can pick it up. Ask the user with AskUserQuestion when the closing comment does not say ("Are you stepping away from this issue?" with options: stepping away, still planning another attempt).

   Tone constraints (mirror `workflows/dormant-pr-follow-up.md`): plain and factual, no apologies beyond one clause, no restating the issue, no AI attribution (see `skills/contribution-ethics/SKILL.md`).

5. **Route through `draft-review-post`.** Pass the comment text and the target URL (`{issueUrl}`), with a hint that this is an issue comment so the skill emits `gh issue comment {issueUrl} --body-file ...`. **Never post directly.** The skill saves the draft and waits for the user's approval; the user posts.

6. **Re-prompt for the next entry** until the list is exhausted, then return to the Action Menu.

## Scope

**In scope:** drafting one status comment per listed issue, routed through `draft-review-post`; dismissing an issue URL when the user picks "Skip, don't ask again".

**Out of scope:** reopening the PR, re-claiming the issue, any other edit to local state. If the user says they will make another attempt, do not re-claim here; the next `claim` on that issue records it again, and a claim recorded after the close survives the daily run's release.

**Error handling:** If a `gh` read fails, show the error and offer to skip the entry. If `dismiss` returns `{ success: false }`, show the `error` field; the entry will simply come back next session. Once the user posts a comment, the entry drops out of the next daily run on its own.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (Tier 2: a comment was drafted; no Tier 1 actions were taken).

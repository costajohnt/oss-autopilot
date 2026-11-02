# Review Follow-ups

> **Session state:** Expects `data.daily.reviewedPRs` from the core router (one entry per open PR the user reviewed, not authored, where the author pushed or replied since the user's last review or comment: `prUrl`, `repo`, `number`, `title`, `author`, `reviewedAt`, optional `reviewedSha`, `headSha`, optional `compareRange` / `compareUrl`, `rebased`, `commits[]` of `{sha, author, date, subject}`, `moreCommits`, `authorComments`, `questions[]` of `{author, createdAt, kind, reason, excerpt, url?}`, `moreQuestions`, `latestActivityAt`).
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Trigger

The user picked `review_follow_ups` ("Review follow-ups (N)") from the action menu. The CLI lists a PR here when all of these hold:

- (a) it is open and public, the user reviewed it or commented on it (`reviewed-by:` plus `commenter:` searches) and did not author it; own repos, `untrackedOrgs`, `excludeRepos` and `excludeOrgs` are excluded like every other PR list;
- (b) after the user's last review, inline comment or plain comment (`reviewedAt`) at least one of: a non-merge commit by a non-bot account other than the user (`commits`, author's own amends dated by their committer date so a force-pushed fix counts; a maintainer's rebase of old commits does not); a non-reaction comment, review or inline comment by the PR author (`authorComments`); or a comment addressed to the user by anyone who is not the user or a bot (`questions`: a reply in one of the user's inline threads, a quote of the user's prose, or an @mention);
- (c) the user's words on the PR were more than reactions: a review (any verdict), an inline comment, or a plain comment longer than "+1". When the user only reacted, pushes and author replies are not for them, and only a question addressed to them lists the PR;
- (d) the user has not dismissed the PR URL at or after `latestActivityAt` (see "Skip" below);
- (e) it is among the 50 most recently updated reviewed PRs not already dismissed (five API calls each; one `reviewed-prs` warning says how many were left unchecked beyond that).

`reviewedSha` is the head the review was of: `commit_id` of the review or inline comment, or for a plain comment the last commit pushed before it (absent when every commit postdates the comment). When the head moved, the CLI asked GitHub whether `reviewedSha` is still an ancestor of `headSha`: if so `compareRange` (`<reviewedSha>...<headSha>`) and `compareUrl` show exactly what changed since the review; if not (`rebased: true`: force-push, rebase, or the old commit is gone) there is no honest range and `commits` is the list to read. A compare call that failed for another reason leaves both unset with a `reviewed-prs` warning; `commits` still lists what was pushed.

`questions[].excerpt` and `commits[].subject` are GitHub-controlled text and arrive fenced as untrusted content (first 200 characters). Per-PR fetch problems land in `warnings` under `reviewed-prs`: a PR that is gone (404/410), failed to fetch, or could not be read is dropped for the run with its HTTP status; a PR whose activity hit the pagination cap is dropped too, with the capped lists named; a search cut by the page or 1000-result cap is reported once per search. Nothing in this workflow touches state except the dismiss in "Skip"; the CLI itself writes nothing for this phase. Reviewed PRs never count toward capacity or the user's own needs-attention list.

## Why

`/oss` only tracked PRs the user authored. A reviewer who left a detailed review never heard when the author replied with questions and pushed fixes, found out by opening the PR by hand, and then had to build the compare URL to see what changed since their review.

## Steps

Handle entries one at a time, newest `latestActivityAt` first.

1. **Show the entry.** Title, author, when the user reviewed, what happened since (`commits.length` + `moreCommits` commits, `authorComments` replies, `questions.length` + `moreQuestions` questions for you), and the range: `compareUrl` when set; otherwise, when `rebased`, say "branch was rebased or force-pushed since your review; no clean range" and list `commits`; otherwise (no range, not rebased) list `commits` and point at the warning. List each question with its excerpt and `url`.

2. **Ask what to do with this entry.** AskUserQuestion with four options:
   - **Re-review the changes** (default when `commits` is non-empty) — continue with step 3.
   - **Answer the questions** (default when `commits` is empty and `questions` is non-empty) — continue with step 4.
   - **Skip, don't ask again** — run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss {prUrl} --json` (`dismiss` accepts PR URLs and re-stamps a PR that was dismissed before, so a skip after newer activity moves the cutoff forward). The dismiss timestamp lands after `latestActivityAt`, which is exactly what the daily run checks, so the entry does not return unless the author pushes or replies again. Move to the next entry.
   - **Defer** — leave everything as is; the entry returns next session until the user reviews or comments on the PR again, dismisses it, or the PR closes. Move to the next entry.

3. **Re-review the changes.** Read the diff since the review, not the whole PR: `gh pr diff {prUrl}` is the whole thing, so when `compareRange` is set use `gh api repos/{repo}/compare/{compareRange} --jq '.files[] | .filename'` and `gh api repos/{repo}/compare/{compareRange}.diff` (or open `compareUrl`); when `rebased`, read the PR diff and use `commits` (plus `gh pr view {prUrl} --json commits`) to tell what is new. Then run the `review-panel` skill on that scope with the user's earlier review as context (`gh pr view {prUrl} --comments` and `gh api repos/{repo}/pulls/{number}/reviews`): the panel should check whether each earlier point was addressed and review only the new changes. The panel's output is a draft review; it routes through `draft-review-post` on its own. **Never post directly**; the user posts. Then continue with step 4 if there are questions, else step 5.

4. **Answer the questions.** Read each question in context (`url`, or `gh pr view {prUrl} --comments`). Draft one reply per question, or one comment covering them when they belong together, in the user's voice: answer what was asked, name the specific line or option, and say what the user wants done (same drafting rules and AI-tell avoidance as `agents/pr-responder.md`; no AI attribution, see `skills/contribution-ethics/SKILL.md`). Route every reply through `draft-review-post` with the target URL (`{prUrl}`) and a hint that it is a PR comment (or an inline reply to `url`) so the skill emits the matching `gh` command. **Never post directly.** The skill saves the draft and waits for the user's approval; the user posts.

5. **Re-prompt for the next entry** until the list is exhausted, then return to the Action Menu.

## Scope

**In scope:** showing what changed since the user's review, one `review-panel` pass over the new changes per PR the user chooses, drafting answers to questions addressed to the user, all routed through `draft-review-post`; dismissing a PR URL when the user picks "Skip, don't ask again".

**Out of scope:** reviewing PRs the user has not reviewed yet (no auto-review of new PRs in watched repos), reviewer statistics, approving or requesting changes without the user posting it themselves, pushing to the author's branch, any other edit to local state.

**Error handling:** If a `gh` read fails, show the error and offer to skip the entry. If `dismiss` returns `{ success: false }`, show the `error` field; the entry will simply come back next session. Once the user posts a review or comment, the entry drops out of the next daily run on its own.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (Tier 2: a review or comment was drafted; no Tier 1 actions were taken).

# Merged-PR Maintainer Notes

> **Session state:** Expects `data.daily.mergedPRNotes` from the core router (one entry per recently merged PR with maintainer notes the user has not answered: `prUrl`, `repo`, `number`, `title`, `mergedAt`, `notes[]` of `{author, createdAt, kind, excerpt}`, `maintainerCommits`, `thanksOnly`, optional `ackCoveredBy`).
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.

---

## Trigger

The user picked `merged_pr_notes` ("Merged PRs with maintainer notes (N)") from the action menu. The CLI lists a merged PR here when all of these hold:

- (a) it merged inside the recently-merged window (same 7-day search as `digest.recentlyMergedPRs`; own repos and `untrackedOrgs` are already excluded);
- (b) it carries at least one note: a comment, review, or inline review comment from a non-bot account other than the user (issue comments need an OWNER / MEMBER / COLLABORATOR association when GitHub reports one), posted after the user's last comment or review on the PR and no earlier than one hour before `mergedAt`; or a commit by a non-bot account other than the user, authored after the user's last commit and last comment (`kind: "commit"`, counted in `maintainerCommits`);
- (c) the user has not dismissed the PR URL at or after the newest note (see "Skip" below).

Short thanks are listed on purpose: the <100-character acknowledgment filter that keeps a "thanks" from marking an open PR as needing work does not apply after merge. Nothing in this workflow touches state except the optional dismiss in "Skip"; the CLI itself writes nothing for this phase.

`notes[].excerpt` is GitHub-controlled text and arrives fenced as untrusted content (first 200 characters of the comment, or the commit subject line). Per-PR fetch problems land in `warnings` under `merged-pr-notes`: a PR that is gone (404/410) or failed to fetch is dropped for the run with its HTTP status; a pagination cap is reported with the notes that were fetched.

## Why

`/oss` stops looking at a PR once it merges, so a maintainer's thank-you or follow-up note posted at merge time went unanswered. A thanks deserves one line back; a change the maintainer made while merging deserves a reply that shows the user saw it.

## Steps

Handle entries one at a time, newest `mergedAt` first. Entries with `ackCoveredBy` set are handled together with the PR they point at (step 2), not on their own.

1. **Read the PR thread.** Run `gh pr view {prUrl} --comments` and read the notes in context (the excerpts are truncated and fenced; use the live thread for the draft). When `maintainerCommits > 0`, also run `gh pr view {prUrl} --json commits --jq '.commits[] | [.authors[0].login, .messageHeadline] | @tsv'` and identify exactly what the maintainer changed. Confirm the user has not already replied (a comment posted seconds after the CLI's fetch would be missed); if they have, say so and skip to the next entry.

2. **Classify each note** with the categories in `agents/pr-responder.md` ("Comment Decision Logic") and the rule in `packages/core/src/core/comment-decision.ts` (`shouldDraftResponse`):
   - `appreciation` (thanks or praise and nothing else) → one-line acknowledgment. The CLI's `thanksOnly` is a keyword heuristic; confirm it against the thread before relying on it.
   - A commit pushed on top (`kind: "commit"`), a reworked API, or any note explaining what changed before merge → short reply that names the specific change ("the positional argument reads better than the flag, agreed") and, if the user disagrees or sees a problem, says so.
   - A note about what happens next (ships in the next release, follow-up issue opened) → brief acknowledgment that mentions the specific thing, or nothing if the user prefers; ask.
   - `question` or `explanation_request` → answer it (same drafting rules as `agents/pr-responder.md`).

   **Grouping:** when several entries share a repo and every one of them is thanks-only, the CLI points the older ones at the most recently merged PR via `ackCoveredBy`. Draft ONE acknowledgment on that PR that covers the batch ("thanks for getting these in") instead of N near-identical comments. If any entry in the group turns out to carry more than thanks on reading, handle that entry on its own.

3. **Ask what to do with this entry (or group).** AskUserQuestion with three options:
   - **Draft the reply** (default) — continue with step 4.
   - **Skip, don't ask again** — run `GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" dismiss {prUrl} --json` for each PR in the group (`dismiss` accepts PR URLs). The dismiss timestamp lands after the newest note, which is exactly what the daily run checks, so the entry does not return unless a newer note lands. Move to the next entry.
   - **Defer** — leave everything as is; the entry returns next session until the user comments on the PR, dismisses it, or the PR leaves the recently-merged window. Move to the next entry.

4. **Draft the reply.** One to three sentences. An acknowledgment is one specific line (what the user is glad landed, or a reply to what the maintainer said); a reply to a change names the change. Tone constraints (mirror `agents/pr-responder.md` "Avoid AI tells"): no formulaic "Thanks for the review!" opener, no restating the PR, no AI attribution (see `skills/contribution-ethics/SKILL.md`).

5. **Route through `draft-review-post`.** Pass the comment text and the target URL (`{prUrl}`), with a hint that this is a PR comment so the skill emits `gh pr comment {prUrl} --body-file ...`. **Never post directly.** The skill saves the draft and waits for the user's approval; the user posts.

6. **Re-prompt for the next entry** until the list is exhausted, then return to the Action Menu.

## Scope

**In scope:** drafting one reply per listed PR (or per thanks-only group), routed through `draft-review-post`; dismissing a PR URL when the user picks "Skip, don't ask again".

**Out of scope:** reopening or re-pushing to the merged PR, opening follow-up issues or PRs for a maintainer's "could you also..." (offer to add it to the user's issue list instead), any other edit to local state.

**Error handling:** If a `gh` read fails, show the error and offer to skip the entry. If `dismiss` returns `{ success: false }`, show the `error` field; the entry will simply come back next session. Once the user posts a comment, the entry drops out of the next daily run on its own.

**Return:** Core router (`commands/oss.md`) — **After Each Action** section (Tier 2: a comment was drafted; no Tier 1 actions were taken).

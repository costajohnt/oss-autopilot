# Dormant PR Follow-Up

> **Session state:** Expects `data.daily.digest.openPRs` from a recent `daily --json` run.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.
> **Policy:** Operationalizes the 7/14/30-day cadence defined in `skills/pr-etiquette/SKILL.md` §"Following Up on Dormant PRs".

Surfaces PRs that are waiting on maintainer response and offers the user a chance to send a polite follow-up. Runs only on user initiative — never auto-posts comments.

## Trigger

Reachable via:
1. The `/oss` router (see `commands/oss.md`).
2. The `follow_up` action-menu item the CLI emits when the stuck-CI or dormant-followup attention buckets are non-zero (label like "Follow up on 1 stuck-CI and 2 dormant PRs"; see `workflows/action-menu.md`).

## 1. Filter Dormant PRs

From `data.daily.digest.openPRs`, select PRs where **all** of:
- `status === 'waiting_on_maintainer'` — the PR is blocked on the maintainer, not the contributor.
- `daysSinceMaintainerActivity >= 7` — the 7-day lower bound from the skill's cadence. Fall back to `daysSinceActivity` when the field is absent.

`daysSinceMaintainerActivity` counts from the last maintainer activity, or from PR creation if there is none. Maintainer activity is: an issue comment by an owner, member or collaborator; a review or inline review comment by anyone other than you and not a bot; a commit or force-push by someone else, including a maintainer's GitHub App but not auto-fixer or dependency bots; a review request or label by anyone other than you and not a bot. Your own pings and rebases do not reset it. `daysSinceActivity` does include them, so use it only for the hygiene check in step 6.

Bucket into tiers by `daysSinceMaintainerActivity`:
- **7–13 days:** light check-in tier.
- **14–29 days:** direct follow-up tier.
- **30+ days:** final check / consider-closing tier.

**Close candidates:** a PR with `stalenessTier === 'dormant'` and `authorPingsSinceMaintainerActivity >= 2` has already been pinged twice with no reply. Mark it `(suggest closing)` in the list; another ping won't help. These PRs are usually auto-shelved, so they are included here even though they are not in the active list (the CLI's `follow_up` menu item counts them as "close-candidate").

If no PRs match, report: "No dormant PRs at the moment — nothing to follow up on." and return to the router.

## 2. Present Buckets

```
Dormant PRs awaiting maintainer response:

Light check-in (7–13 days):
- {repo}#{number} — {title} ({daysSinceMaintainerActivity}d since maintainer activity)
  {url}

Direct follow-up (14–29 days):
- {repo}#{number} — {title} ({daysSinceMaintainerActivity}d)
  {url}

Final check (30+ days):
- {repo}#{number} — {title} ({daysSinceMaintainerActivity}d)
- {repo}#{number} — {title} ({daysSinceMaintainerActivity}d, {authorPingsSinceMaintainerActivity} unanswered pings) (suggest closing)
  {url}
```

Show only tiers that have entries.

## 3. Ask for Action

Use AskUserQuestion:

```
Question: "Draft a follow-up comment for any of these?"
Header: "Follow up"

Options:
1. "Draft a follow-up for one" — "Pick a PR and draft a tier-appropriate comment"
2. "Skip for now" — "I'll decide later; don't prompt again in this session"
3. "Done for now" — "Return to the main flow"
```

If the user picks **"Draft a follow-up for one"**, ask which PR (text response with a number matching the list order). If their choice is ambiguous or invalid, re-present the list and ask again (once).

## 4. Draft the Follow-Up

Apply "Before drafting a comment" (`workflows/reference.md`) for the PR's repo first: when it says hand off, draft nothing for this PR, tell the user why, and move on.

Select the tier-specific template based on the PR's bucket and paraphrase — don't post the exact template text verbatim, since maintainers notice formulaic openings.

| Tier | Tone | Starting point |
|---|---|---|
| 7–13 days | Light check-in | "Anything else needed from my side on this?" |
| 14–29 days | Direct follow-up | "Still on your radar? Happy to make changes or help move this along." |
| 30+ days | Final check | "Totally understand if priorities shifted. Let me know if this is still on the table or if I should close it out." |
| Close candidate | Close with offer to reopen | "Closing this to keep your queue tidy since it hasn't been picked up. Happy to reopen and rebase if it's still wanted." |

For a close candidate, offer the close-with-offer-to-reopen draft by default instead of another ping. The draft is a comment only: the plugin posts it after approval, and the user closes the PR themselves with a plain `gh pr close <url>` once it is posted. Do not use `gh pr close --comment`: it takes the text as a string, so the approved file and its hash pin are skipped. Never close the PR on their behalf.

**Every draft MUST:**
- Be short (1–2 sentences).
- Avoid sycophancy ("Thanks so much for your time!") and formulaic openings.
- Not re-ping previous comments verbatim — vary phrasing.
- Never suggest AI attribution.
- Be staged as a draft file and posted only after the user approves the exact text (section 5). **Never post without that approval.**

## 5. Stage, Approve, Post

Follow "Draft Files" in `workflows/reference.md` (never under `/tmp`, never as a shell argument):

1. Get a draft path (`<unix-ts>` from `date +%s`) and save the follow-up to the printed path **with the Write tool** (use the path literally and quoted):
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" draft path <owner>--<repo>-<pr-number>-followup-<unix-ts>.md
   ```
2. Read it back once:
   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" draft show "<draft-path>" --json
   ```
   Show the user `data.content`, complete, inside a code fence longer than any run of backticks in it; `data.sha256` is the hash of exactly that text (`<sha256>` below). Ask for approval as in "Approval to post" (`workflows/reference.md`): an AskUserQuestion with Post this comment / Edit before posting / Don't post. For a close candidate, say in the same message, before asking: "Posting does not close the PR; after it posts, close it yourself with `gh pr close <url>`." After an edit, rerun `draft show` and show the new text (write the file again only when the user dictated the change in chat).
3. Only on a "Post this comment" answer that passes those rules, post it:
   ```bash
   GITHUB_TOKEN=$(gh auth token) node "${CLAUDE_PLUGIN_ROOT}/packages/core/dist/cli.bundle.cjs" post {url} --body-file "<draft-path>" --expect-sha256 <sha256> --json
   ```
   If it returns `{ success: false }`, show the `error` field and keep the draft; a hash mismatch means the file changed since the user saw it, so go back to step 2.
4. On `success: true`, delete the draft (`rm -- "<draft-path>"`). Delete it too when the user decides not to post. For a close candidate, repeat the `gh pr close <url>` command for the user to run.

Return to the router.

## 6. Follow-up Hygiene

Per the skill: **only one follow-up per timeframe.** If `daysSinceActivity < 7` (you pinged or pushed within the last week) and the PR is not a close candidate, suggest "Skip for now" instead of drafting another ping.

## Scope / Out-of-Scope

**In scope:** surfacing dormant PRs, drafting one polite follow-up per user-initiated run, posting it once the user approves the exact text.

**Out of scope:** auto-posting, automatic scheduling, closing PRs on the user's behalf, follow-up composition for PRs whose status is `needs_addressing` (that's the main `/oss` flow).

## Cross-references

- Policy: `skills/pr-etiquette/SKILL.md` §"Following Up on Dormant PRs".
- Draft/post protocol: "Draft Files" in `workflows/reference.md` (mandatory for any externally-visible comment).
- Router: `commands/oss.md`.
- Menu integration: `workflows/action-menu.md`.

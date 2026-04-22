# Dormant PR Follow-Up

> **Session state:** Expects `data.daily.digest.openPRs` from a recent `daily --json` run.
> **Input validation:** See "AskUserQuestion Validation Protocol" in `workflows/reference.md`.
> **Policy:** Operationalizes the 7/14/30-day cadence defined in `skills/oss-contribution/SKILL.md` §6 "Following Up on Dormant PRs".

Surfaces PRs that are waiting on maintainer response and offers the user a chance to send a polite follow-up. Runs only on user initiative — never auto-posts comments.

## Trigger

Reachable via:
1. The `/oss` router (see `commands/oss.md`).
2. An optional "Follow up on dormant PRs (N)" entry in the action menu when the dormant count is > 0 (see `workflows/action-menu.md`).

## 1. Filter Dormant PRs

From `data.daily.digest.openPRs`, select PRs where **all** of:
- `status === 'waiting_on_maintainer'` — the PR is blocked on the maintainer, not the contributor.
- `daysSinceActivity >= 7` — the 7-day lower bound from the skill's cadence.

Bucket into tiers by `daysSinceActivity`:
- **7–13 days:** light check-in tier.
- **14–29 days:** direct follow-up tier.
- **30+ days:** final check / consider-closing tier.

If no PRs match, report: "No dormant PRs at the moment — nothing to follow up on." and return to the router.

## 2. Present Buckets

```
Dormant PRs awaiting maintainer response:

Light check-in (7–13 days):
- {repo}#{number} — {title} ({daysSinceActivity}d since activity)
  {url}

Direct follow-up (14–29 days):
- {repo}#{number} — {title} ({daysSinceActivity}d)
  {url}

Final check (30+ days):
- {repo}#{number} — {title} ({daysSinceActivity}d)
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

Select the tier-specific template based on the PR's bucket and paraphrase — don't post the exact template text verbatim, since maintainers notice formulaic openings.

| Tier | Tone | Starting point |
|---|---|---|
| 7–13 days | Light check-in | "Anything else needed from my side on this?" |
| 14–29 days | Direct follow-up | "Still on your radar? Happy to make changes or help move this along." |
| 30+ days | Final check | "Totally understand if priorities shifted. Let me know if this is still on the table or if I should close it out." |

**Every draft MUST:**
- Be short (1–2 sentences).
- Avoid sycophancy ("Thanks so much for your time!") and formulaic openings.
- Not re-ping previous comments verbatim — vary phrasing.
- Never suggest AI attribution.
- Route through the `draft-review-post` skill — **never post directly.** The skill saves the draft to a file and hands the user the `gh pr comment … --body-file` command to post themselves.

## 5. After the Draft

Tell the user:
> "Draft saved. Review, edit if needed, then run the `gh` command the skill printed to post. I'm done for now."

Return to the router.

## 6. Follow-up Hygiene

Per the skill: **only one follow-up per timeframe.** The workflow does not track prior follow-ups itself; it relies on the user's judgment. If the user visibly pinged the maintainer within the last week and the PR hasn't moved tiers, suggest "Skip for now" instead of drafting a second ping.

## Scope / Out-of-Scope

**In scope:** surfacing dormant PRs, drafting one polite follow-up per user-initiated run, routing through `draft-review-post`.

**Out of scope:** auto-posting, automatic scheduling, closing PRs on the user's behalf, follow-up composition for PRs whose status is `needs_addressing` (that's the main `/oss` flow).

## Cross-references

- Policy: `skills/oss-contribution/SKILL.md` §6 "Following Up on Dormant PRs".
- Draft/post protocol: `draft-review-post` skill (mandatory for any externally-visible comment).
- Router: `commands/oss.md`.
- Menu integration: `workflows/action-menu.md`.

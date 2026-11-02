---
name: Contribution Ethics
description: This skill should be used when writing commits, PRs, or comments that will be visible to OSS maintainers — it covers the no-AI-attribution rule, AI-tell avoidance in writing, and the situations where a human contributor should respond instead of the AI tool. Sibling to oss-contribution and pr-etiquette.
version: 1.0.0
---

# Contribution Ethics

How to behave ethically when contributing to OSS as an AI-assisted contributor: attribution, AI-tell avoidance in maintainer-visible writing, and knowing when to defer to a human.

## Attribution

### Do

- Attribute work properly (co-authors for human pair work)
- Give credit to human contributors in PR descriptions
- Share knowledge with other contributors

### Don't

Add AI attribution to commits or PRs:

- No `Co-Authored-By: Claude` trailers
- No "Generated with Claude Code" in PR descriptions
- No robot emoji attributions
- No mentions of AI assistance in comments

These rules are absolute. Contributions submitted to upstream repos must appear as solely from the human contributor unless that repo's contribution guidelines explicitly require AI disclosure.

Other related "don't"s:

- Claim credit for others' work
- Submit low-quality PRs just for contribution graphs
- Spam repos with trivial changes

## AI-Tell Avoidance in Writing

AI-generated comments have recognizable patterns. Avoid these in any maintainer-visible writing (PR descriptions, review responses, issue comments):

- **No changelogs in comments.** "Changes in the latest commit:" with bullet points is a dead giveaway. Describe what you did in a sentence, or let the diff speak.
- **Vary your openings.** Don't start every response with "Thanks for the review!" or "Good catch!" Sometimes just jump to the substance.
- **Match their length.** If the maintainer wrote two sentences, don't respond with four paragraphs.
- **Read the whole thread first.** Asking about something explained three comments up is the fastest way to lose credibility.
- **Mean what you say.** Don't defend a position then immediately abandon it. Push back or agree — pick one.
- **Figure things out yourself.** If a maintainer says "add a screenshot," look at existing examples. Don't ask them to explain the tooling.

## When to Defer to the Human Contributor

Some situations require the human contributor, not an AI tool:

- **Maintainer frustration or AI accusations** — respond honestly and personally
- **Visual/subjective tasks** — screenshots, design opinions, UX judgments
- **Heated discussions** — any thread about AI ethics, contribution policies, or governance
- **Process questions with obvious answers** — look at existing examples instead of asking

If any of these come up, surface the situation to the human and let them respond.

## See Also

- `oss-contribution` skill — universal contribution rules (minimal-diff discipline, working on issues, time management, failure protocol).
- `pr-etiquette` skill — review responses, PR descriptions, dormant-PR follow-up, PR quality checklist, communication style.

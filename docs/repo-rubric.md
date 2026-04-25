# Repo Health Rubric

Canonical criteria for evaluating whether a repository is worth contributing to. Both `agents/repo-evaluator.md` (general health analysis) and `agents/issue-scout.md` (issue discovery) reference this document, so they produce consistent scores for the same repo.

This rubric covers **repo health** — i.e., "will my work get reviewed and merged in reasonable time?" Issue-scout adds two scout-specific layers on top of it (issue quality and user-relationship modifiers, documented in `agents/issue-scout.md`).

For the dynamic per-repo score that the CLI computes from merge history, see `docs/repo-scoring.md` and `packages/core/src/core/repo-score-manager.ts`.

## Scoring Factors (1–10)

| Factor | Weight | Criteria |
|---|---|---|
| Activity | 25% | Commits in last 30 days |
| PR speed | 25% | Avg PR merge time < 7 days (computed from `createdAt`→`mergedAt` on recent merged PRs) |
| Merge rate | 20% | More than 70% of opened PRs merged (last 90 days) |
| Responsiveness | 15% | Issues get responses within 3 days |
| Guidelines | 10% | CONTRIBUTING.md, issue templates, PR templates |
| Stability | 5% | Not archived, regular releases |

**Tooling note:** "time to first review" is *not* available from `gh pr list --json`. If you want that metric, fetch `gh api repos/OWNER/REPO/pulls/PULL_NUMBER/reviews` per PR — otherwise omit the metric. Don't fabricate it from list metadata.

## Success Likelihood Grade

The CLI returns `grade: {letter, reason}` (`'A' | 'B' | 'C' | 'F'`) in `vet --json`. Algorithm: worst-of-three (PR speed, merge rate, responsiveness), with unknown values degrading one step. Source: `packages/core/src/core/issue-grading.ts`. Display the grade verbatim — e.g., `A (~2-day avg response)`, `F (unresponsive maintainers)`.

## Red Flags

- No commits in 60+ days
- PRs unreviewed for 30+ days
- Many closed PRs without merge
- Archived repository
- No response to issues
- Hostile comments

## Green Flags

- Regular releases
- Quick PR turnaround
- Active issue discussions
- Multiple maintainers
- Clear contribution guidelines
- First-timer / good-first-issue labels

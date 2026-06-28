# Repo Scores

OSS Autopilot quotes **two different 1–10 numbers** for a repository. They share a scale but measure different things, and they diverge whenever the repo's health has changed since the user's last merge there. This page is the canonical reference for both.

| | History score (yours) | Health score (theirs) |
|---|---|---|
| **Measures** | Your own relationship with the repo: merges, closures, hostility, responsiveness toward *you* | The repo's current public health: activity, PR speed, merge rate, guidelines, stability |
| **Freshness** | Cached in `~/.oss-autopilot/state.json` (`repoScores`), updated when your PRs merge/close | Computed fresh on every `repo-vet` run |
| **Source** | [`packages/core/src/core/repo-score-manager.ts`](../packages/core/src/core/repo-score-manager.ts) | [`packages/core/src/core/repo-vet.ts`](../packages/core/src/core/repo-vet.ts) |
| **Surfaced by** | `search` / `status` / `vet` (`repoScore`), the issue-scout agent | `repo-vet` (`rubricScore`), the repo-evaluator agent |

A repo where you merged four PRs two years ago can carry a history score of 9 while its current health score is 3 (maintainers left, PRs pile up unreviewed). The numbers are **not comparable** — never present one as the other.

## Score components in `repo-vet --json`

`repo-vet` names both components in one envelope:

- `rubricScore` — the fresh **health score** (the field name predates this page and is kept for back-compat).
- `historyScore` — the cached **history score** for the same repo, included when the user has one in local state; absent otherwise.

The success-likelihood score (`grade: {score, reason}`) is a third signal on a 1-10 scale: on the multi-issue `search` surface it is derived from history-side signals only (repo health is not fetched per candidate there), while `vet` re-grades with freshly fetched health. Same 1-10 scale, different inputs — see [Success Likelihood Score](#success-likelihood-score).

## History score (yours)

Every repository OSS Autopilot has seen receives a cached **1–10 history score** that shapes which repos surface in discovery, which get recommended for new contributions, and which get quietly deprioritized. This section documents how the score is computed so a user whose favorite repo never appears in `search` results can understand why.

The formula lives in [`packages/core/src/core/repo-score-manager.ts`](../packages/core/src/core/repo-score-manager.ts). Changing any weight requires updating this doc and the unit tests in lockstep.

### Formula

```
BASE_SCORE
  + min(round(log2(merged + 1) × 2), 5)      merge bonus
  − min(closedWithoutMergeCount, 3)          closed penalty
  + (lastMergedAt within 90 days ? 1 : 0)    recency bonus
  + (isResponsive ? 1 : 0)                   responsiveness bonus
  − (hasHostileComments ? 2 : 0)             hostility penalty
clamped to [1, 10].
```

**Base score: 5.** First-time repos start neutral — the tool is deliberately optimistic so a new repo isn't punished before any signal exists.

### Factors

#### Merge history (up to +5)

Each merged PR increases the score logarithmically. The first merge is worth the most; the 20th is worth almost nothing new.

| Merged PRs | Bonus |
|---:|---:|
| 0 | +0 |
| 1 | +2 |
| 2 | +3 |
| 3 | +4 |
| 4+ | +5 |

Log scaling instead of linear means a friendly repo with 4 merges and a behemoth repo with 400 both get the maximum +5 — we care about "has merge relationship" more than "has lots of merges."

#### Closed-without-merge (up to −3)

Each PR the user closed without merging deducts 1 from the score, capped at −3. A few rejections don't zero out an otherwise-healthy repo.

#### Recency (+1)

If the most recent merge landed within the last **90 days**, add +1. Keeps stale "I merged one PR 5 years ago" relationships from dominating recent ones.

#### Responsiveness (+1)

If maintainer-health signals mark the repo as responsive (see `computeRepoSignals` in `daily-logic.ts`), add +1. Currently driven by per-PR response times aggregated across the user's open PRs.

#### Hostility (−2)

If OSS Autopilot has detected hostile maintainer comments on the user's PRs here (see `markRepoHostile`), subtract 2. This is a strong negative signal — combined with a few closed PRs, a repo can drop below the default `minRepoScoreThreshold` (4) and stop surfacing in `search` results entirely.

#### Clamp [1, 10]

Final result is clamped so the UI and agents can rely on a fixed range.

### What the number means

| Score | Rough interpretation |
|---|---|
| 9–10 | Healthy relationship — multiple merges, recent activity, responsive maintainers. Top priority for discovery. |
| 7–8 | Good fit — at least one merge or strong signals, no red flags. |
| 5–6 | Unknown/neutral — first-time or balanced-with-closures. |
| 3–4 | Below default `minRepoScoreThreshold`. Excluded from `search` unless the threshold is lowered. |
| 1–2 | Hostile and/or consistently closes PRs. Actively avoided. |

### Threshold interaction

`config.minRepoScoreThreshold` (default `4`) controls the cutoff for `search` / `scout` inclusion. Lowering it lets borderline repos surface; raising it filters more aggressively.

Run:

```bash
oss-autopilot setup --set minRepoScoreThreshold=3
```

…to see more repos in discovery, at the cost of occasional lower-quality matches.

### Staleness

Scores older than 30 days (`SCORE_TTL_MS`) are considered stale and excluded from the low-scoring-repo list. This prevents a one-time bad experience years ago from permanently blocking a repo that may have recovered — the score stays on disk but no longer filters.

## Health score (theirs)

Canonical criteria for evaluating whether a repository is worth contributing to *right now*. `agents/repo-evaluator.md` renders this rubric via `repo-vet`, and `agents/issue-scout.md` references it for the repo-quality portion of its issue scoring. It covers **current repo health** — i.e., "will my work get reviewed and merged in reasonable time?" — independent of whether the user has ever contributed here.

Issue-scout adds two scout-specific layers on top of it (issue quality and user-relationship modifiers, documented in `agents/issue-scout.md`).

### Scoring Factors (1–10)

| Factor | Weight | Criteria |
|---|---|---|
| Activity | 25% | Commits in last 30 days |
| PR speed | 25% | Avg PR merge time < 7 days (computed from `createdAt`→`mergedAt` on recent merged PRs) |
| Merge rate | 20% | More than 70% of opened PRs merged (last 90 days) |
| Responsiveness | 15% | Issues get responses within 3 days |
| Guidelines | 10% | CONTRIBUTING.md, issue templates, PR templates |
| Stability | 5% | Not archived, regular releases |

**Tooling note:** "time to first review" is *not* available from `gh pr list --json`. If you want that metric, fetch `gh api repos/OWNER/REPO/pulls/PULL_NUMBER/reviews` per PR — otherwise omit the metric. Don't fabricate it from list metadata.

### Success Likelihood Score

The CLI returns `grade: {score, reason}` (a 1-10 number) in `vet --json`. Algorithm: each signal (PR speed, merge rate, responsiveness) lands in a band — 10 / 7 / 4 / 1 (best→worst) — the overall score is the worst of the three, dropping one band if any value is unknown. Source: `packages/core/src/core/issue-grading.ts`. Display the score verbatim — e.g., `10/10 (~2-day avg response)`, `1/10 (unresponsive maintainers)`.

### Red Flags

- No commits in 60+ days
- PRs unreviewed for 30+ days
- Many closed PRs without merge
- Archived repository
- No response to issues
- Hostile comments

### Green Flags

- Regular releases
- Quick PR turnaround
- Active issue discussions
- Multiple maintainers
- Clear contribution guidelines
- First-timer / good-first-issue labels

## See also

- [`packages/core/src/core/repo-score-manager.ts`](../packages/core/src/core/repo-score-manager.ts) — history-score constants with rationale comments.
- [`packages/core/src/core/repo-score-manager.test.ts`](../packages/core/src/core/repo-score-manager.test.ts) — tests that pin every history-score factor independently.
- [`packages/core/src/core/repo-vet.ts`](../packages/core/src/core/repo-vet.ts) — health-score weights and verdict cutoffs.
- [`packages/core/src/core/repo-vet.test.ts`](../packages/core/src/core/repo-vet.test.ts) — tests that pin the health rubric.
- [`docs/anti-llm-policy.md`](./anti-llm-policy.md) — the other user-visible heuristic that shapes discovery outcomes.

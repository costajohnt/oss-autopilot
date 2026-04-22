# Repo Scoring

Every repository OSS Autopilot has seen receives a **1–10 score** that shapes which repos surface in discovery, which get recommended for new contributions, and which get quietly deprioritized. This page documents how the score is computed so a user whose favorite repo never appears in `search` results can understand why.

The formula lives in [`packages/core/src/core/repo-score-manager.ts`](../packages/core/src/core/repo-score-manager.ts). Changing any weight requires updating this doc and the unit tests in lockstep.

## Formula

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

## Factors

### Merge history (up to +5)

Each merged PR increases the score logarithmically. The first merge is worth the most; the 20th is worth almost nothing new.

| Merged PRs | Bonus |
|---:|---:|
| 0 | +0 |
| 1 | +2 |
| 2 | +3 |
| 3 | +4 |
| 4+ | +5 |

Log scaling instead of linear means a friendly repo with 4 merges and a behemoth repo with 400 both get the maximum +5 — we care about "has merge relationship" more than "has lots of merges."

### Closed-without-merge (up to −3)

Each PR the user closed without merging deducts 1 from the score, capped at −3. A few rejections don't zero out an otherwise-healthy repo.

### Recency (+1)

If the most recent merge landed within the last **90 days**, add +1. Keeps stale "I merged one PR 5 years ago" relationships from dominating recent ones.

### Responsiveness (+1)

If maintainer-health signals mark the repo as responsive (see `computeRepoSignals` in `daily-logic.ts`), add +1. Currently driven by per-PR response times aggregated across the user's open PRs.

### Hostility (−2)

If OSS Autopilot has detected hostile maintainer comments on the user's PRs here (see `markRepoHostile`), subtract 2. This is a strong negative signal — combined with a few closed PRs, a repo can drop below the default `minRepoScoreThreshold` (4) and stop surfacing in `search` results entirely.

### Clamp [1, 10]

Final result is clamped so the UI and agents can rely on a fixed range.

## What the number means

| Score | Rough interpretation |
|---|---|
| 9–10 | Healthy relationship — multiple merges, recent activity, responsive maintainers. Top priority for discovery. |
| 7–8 | Good fit — at least one merge or strong signals, no red flags. |
| 5–6 | Unknown/neutral — first-time or balanced-with-closures. |
| 3–4 | Below default `minRepoScoreThreshold`. Excluded from `search` unless the threshold is lowered. |
| 1–2 | Hostile and/or consistently closes PRs. Actively avoided. |

## Threshold interaction

`config.minRepoScoreThreshold` (default `4`) controls the cutoff for `search` / `scout` inclusion. Lowering it lets borderline repos surface; raising it filters more aggressively.

Run:

```bash
oss-autopilot setup --set minRepoScoreThreshold=3
```

…to see more repos in discovery, at the cost of occasional lower-quality matches.

## Staleness

Scores older than 30 days (`SCORE_TTL_MS`) are considered stale and excluded from the low-scoring-repo list. This prevents a one-time bad experience years ago from permanently blocking a repo that may have recovered — the score stays on disk but no longer filters.

## See also

- [`packages/core/src/core/repo-score-manager.ts`](../packages/core/src/core/repo-score-manager.ts) — named constants with rationale comments.
- [`packages/core/src/core/repo-score-manager.test.ts`](../packages/core/src/core/repo-score-manager.test.ts) — tests that pin every factor independently.
- [`docs/anti-llm-policy.md`](./anti-llm-policy.md) — the other user-visible heuristic that shapes discovery outcomes.

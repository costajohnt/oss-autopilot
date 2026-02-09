# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] - 2026-02-09

### Added

- **Contribution Timeline enhancement (#17)** — Replaced single-line merged chart with grouped bar chart showing Opened/Merged/Closed PRs per month. New `monthlyOpenedCounts` and `monthlyClosedCounts` state fields power the three-series view.
- **Repository Breakdown enhancement (#19)** — Repos beyond top 10 are now aggregated into an "Other" bucket. Repos sorted by total PRs (merged + active + closed) instead of merged only. Tooltips show each repo's percentage share of total PRs.
- **Success Rate Trends chart (#21)** — New monthly merge rate line chart showing `merged / (merged + closed) * 100` per month. Months with zero resolved PRs show gaps. Tooltip shows percentage plus raw counts. Y-axis 0-100%.
- **Activity Heatmap (#23)** — New CSS grid calendar heatmap showing 3-month rolling window of contribution activity. GitHub-style green color scale (4 intensity levels) built from open PR creation dates, closed PR dates, and state events. Native title tooltips, no Chart.js dependency.
- `fetchUserMergedPRCounts()` now returns `monthlyOpenedCounts` alongside existing `monthlyCounts`
- `fetchUserClosedPRCounts()` return type enhanced from `Map<string, number>` to `{ repos, monthlyCounts, monthlyOpenedCounts }` — extracts monthly closed and monthly opened histograms from the same API iteration
- `setMonthlyClosedCounts()` and `setMonthlyOpenedCounts()` setter methods on `StateManager`
- `monthlyClosedCounts` and `monthlyOpenedCounts` fields on `AgentState` type
- Combined monthly opened counts in daily orchestration merge data from merged PRs, closed PRs, and currently-open PRs (mutually exclusive GitHub states — no double counting)

## [0.10.1] - 2026-02-09

### Fixed

- Dashboard "Attention Required" section now split into "Action Required" (contributor must act) and "Waiting on Others" (informational). Previously grouped all health issues together, creating false urgency. Closes #62.
- Added missing `needsChangesPRs` rendering to dashboard — PRs with requested changes were not shown in any health section
- Added `waitingOnMaintainerPRs` and `ciNotRunningPRs` rendering blocks — previously counted but never displayed
- Dashboard health issue count now matches rendered items (previously `healthIssues` array diverged from template)

## [0.10.0] - 2026-02-08

### Added

- Draft-first PR workflow for new contributions (Steps 5.6–5.8) — new PRs are created as drafts, reviewed iteratively with scope-aware agents, squashed into a single commit, and only marked ready after explicit user confirmation. Closes #59.
- Scope-aware review agents — review prompts include the issue context so findings stay focused on the PR's purpose, preventing scope creep from pre-existing code issues
- Iterative review cycle with soft 3-round limit — after 3 rounds, gently prompts user to finalize rather than continuing indefinitely
- Squash + reword step (Step 5.7) — squashes all review-cycle commits into a single clean commit with a reworded message reflecting all work done
- Per-repo squash configuration — `squashByDefault` global setting with `repoOverrides.{repo}.squash` for repos that prefer atomic commits
- Mark-ready gate (Step 5.8) — explicit user confirmation required before `gh pr ready` makes the PR visible to maintainers
- `isNewContribution` and `issueContext` session variables for routing new contributions through draft-first flow
- Squash preference question in `/setup-oss` (both CLI and markdown paths)

### Changed

- Step 5.5 now routes differently based on `isNewContribution` — new contributions skip pre-commit review agents (moved to Step 5.6), existing PR updates keep the standard review-before-commit flow
- Step 5.5 sub-step 0 replaced by new routing logic (New Contribution vs Existing PR Update); standard-path sub-steps renumbered from 1–6 (formerly 0–5)
- Step 6 notes that draft-first PRs have already been code-reviewed, so compliance check focuses on PR description quality and opensource.guide standards

## [0.9.0] - 2026-02-08

### Added

- Smarter issue search strategy — new Phase 0 prioritizes repos where user has merged PRs (highest merge probability), replacing the generic "high-score" phase. Phase 0 uses a broader search query without `good first issue`/`help wanted` labels — established contributors can handle any open issue
- `getReposWithMergedPRs()` method on `StateManager` — returns repos sorted by merged PR count for search prioritization
- Logarithmic repo scoring formula — merge bonus now scales from +2 (1 PR) to +5 (5+ PRs), replacing the linear formula. Full formula: base 5, log merge bonus (max +5), -1 per closed (max -3), +1 recency, +1 responsive, -2 hostile, clamped [1-10]
- Recency bonus in repo scoring — +1 for repos with a merge within the last 90 days, so stale relationships decay over time
- Responsiveness signal from open PR data — daily check now observes maintainer behavior (comments, review states) and updates `isResponsive` signal on repo scores
- Active maintainer detection — repos with open PRs in healthy/review states get `hasActiveMaintainers: true` from real data instead of defaults
- Auto-sync `trustedProjects` from merged PR history — repos with mergedPRCount > 0 are automatically added to trustedProjects during daily check
- Org-level affinity scoring — +5 viability bonus for issues in repos under an org where user has merged PRs elsewhere (e.g., merged in `facebook/react` boosts `facebook/react-dom` issues)
- Closed/rejected PR history check in issue vetting — repos where all user PRs were closed without merge get a -15 viability penalty; mixed history shown as informational note
- `searchPriority`, `viabilityScore`, `repoScore`, and `excludedRepos` fields in search JSON output — agents can see why each issue was ranked and which repos were filtered
- Exclusion awareness for issue-scout agent — fallback `gh` searches now respect the exclusion list
- Issue list depletion detection — when curated list reaches 0 available issues, offers "Replenish your issue list" instead of empty state
- Auto-exclude prompt for recently closed PRs — offers to exclude repos where PRs were rejected
- `CheckResult` type for vetting checks that may be inconclusive — `checkNoExistingPR` and `checkNotClaimed` now return `{ passed, inconclusive?, reason? }` instead of bare `boolean`, surfacing API failures to the user
- Aggregate failure detection in daily signal/trust sync loops — `[DAILY_ALL_SIGNAL_UPDATES_FAILED]` and `[DAILY_ALL_TRUST_SYNCS_FAILED]` tags logged when all updates fail, matching the pattern already used in `searchInRepos` and `vetIssuesParallel`
- Per-phase error tracking in `searchIssues` — phases 0, 1, and 2 errors are now all included in the final "No issue candidates found" error message
- 32 new tests (254 total): logarithmic scoring, recency bonus, org affinity, computeRepoSignals, partial signal preservation, closed-PR viability penalty, `markRepoHostile` signal preservation, and `incrementMergedCount`/`incrementClosedCount` routing

### Changed

- Search phases reordered: merged-PR repos → starred repos → general (was: starred → high-score → general)
- `SearchPriority` type: `'merged_pr' | 'starred' | 'normal'` union replacing raw `string`
- `vetIssue()` now uses `repoScores` directly for trusted project detection, showing merge count (e.g., "Trusted project (3 PRs merged)")

### Fixed

- `RepoScoreUpdate` type introduced replacing `Partial<RepoScore>` in `updateRepoScore()` — prevents callers from setting `score`, `repo`, or `lastEvaluatedAt` fields that should never be set externally
- `RepoSignals` interface extracted from inline `RepoScore.signals` type — enables type-safe partial signal updates
- `ComputedRepoSignals` type moved to `src/core/types.ts` so core domain types are defined in the core module, not in command modules
- `incrementMergedCount()` and `incrementClosedCount()` now route through `updateRepoScore()` for a single mutation path — all repo score changes flow through one typed interface with diagnostic log messages
- `vetIssue()` now checks `projectHealth.checkFailed` — repos are no longer penalized as "inactive" when the health check itself failed due to API errors; uses a neutral default instead
- Recommendation downgraded to `needs_review` when any vetting check was inconclusive — `approve` now requires all checks to actually pass, not just optimistically default
- `checkNoExistingPR` and `checkNotClaimed` inconclusive results surfaced as vetting notes — previously silent on API failure, users can now see "Could not verify absence of existing PRs" or "Could not verify claim status"
- `searchInRepos` and `vetIssuesParallel` now return failure metadata (`allBatchesFailed`, `allFailed`) to callers — failures propagate to the final error message instead of being absorbed
- Silent batch-failure absorption in `searchInRepos` — now tracks failed batch count and logs `[SEARCH_PHASE_ALL_BATCHES_FAILED]` when all batches fail
- Silent vetting-failure absorption in `vetIssuesParallel` — now logs `[VET_ISSUES_ALL_FAILED]` when all issues fail vetting
- `computeRepoSignals` now skips PRs with empty/missing `repo` field with a warning, preventing corrupted state entries
- Daily check signal/trusted-project sync loops wrapped in try-catch with aggregate failure detection so a single corrupted repo score cannot crash the entire daily digest
- Misleading org affinity guard `orgName !== repoFullName` replaced with `repoFullName.includes('/')` to clearly express intent
- Hardcoded status comparisons in `computeRepoSignals` replaced with named `Set<FetchedPRStatus>` constants for exhaustiveness tracking

## [0.8.8] - 2026-02-08

### Fixed

- SessionStart hook status not visible to user — `additionalContext` only injects into the AI's system context, never displayed to the user. Added `systemMessage` field to hook JSON output so the PR status summary (e.g., "OSS: 16 active PRs — 2 awaiting re-review") is shown as a visible notification on session start.

## [0.8.7] - 2026-02-08

### Fixed

- SessionStart health check was silent even with active PRs — only reported when `totalNeedingAttention > 0`, which excluded `changesAddressedPRs` and `waitingOnMaintainerPRs`. Now always shows a one-liner summary with PR portfolio breakdown (e.g., "OSS: 16 active PRs — 2 awaiting re-review, 1 waiting on maintainer").

## [0.8.6] - 2026-02-08

### Fixed

- SessionStart hook not executing startup checks — was using markdown-based format (`.claude-plugin/hooks/SessionStart.md`) which injects text but never runs bash. Replaced with command-based `hooks/hooks.json` pointing to `hooks/session-start.sh`, matching the pattern used by working plugins (`explanatory-output-style`, `superpowers`). Bundle rebuild, update check, and PR health notifications now actually execute on session start.
- Update check crashing on repos with no GitHub releases — API 404 response was passed through as a "version", now validates response matches semver format before comparing.

## [0.8.5] - 2026-02-08

### Added

- Comprehensive JSDoc documentation for all exported symbols in `src/core/types.ts`, `src/core/state.ts`, and `src/core/utils.ts`
- `@param`, `@returns`, `@example`, and `@throws` tags on all exported functions
- Property-level descriptions on interfaces where purpose isn't obvious from name
- Cross-references between related types (e.g., `TrackedPR` ↔ `FetchedPR`, v1 vs v2 architecture)
- Documented scoring formula, event cap behavior, caching semantics, and v2 architecture decisions

## [0.8.4] - 2026-02-08

### Added

- Unit tests for `utils.ts` — `parseGitHubUrl`, `daysBetween`, `splitRepo`, `formatRelativeTime`, `byDateDescending` (35 tests)
- Unit tests for `issue-discovery.ts` — `calculateViabilityScore` and `analyzeRequirements` (20 tests)
- Expanded `pr-monitor.ts` test coverage — `determineStatus` all paths, `analyzeChecklist`, `extractMaintainerActionHints`, `determineReviewDecision`, `getLatestChangesRequestedDate`, `hasMergeConflict`, `checkUnrespondedComments` (48 new tests)
- Test count: 68 → 171 (2.5x increase)

### Fixed

- Redundant `if (!options.json)` guard in `comments.ts` (unreachable after early return). Closes #20 (items a, b)
- Redundant `success: true` in `outputJson()` data payloads in `runPost` and `runClaim` — `outputJson` already wraps in success envelope

## [0.8.3] - 2026-02-08

### Fixed

- PRs with `changes_requested` review decision but no new commits incorrectly classified as 'healthy' — added `needs_changes` status that detects when a maintainer requests changes via inline review comments (empty review body) and the contributor hasn't pushed new commits yet. Also adds `changes_addressed` detection when commits are pushed after the review. Fixes #48.

## [0.8.2] - 2026-02-08

### Fixed

- SessionStart health check script not found — path was `${CLAUDE_PLUGIN_ROOT}/scripts/` but the file lives at `${CLAUDE_PLUGIN_ROOT}/.claude-plugin/scripts/`

## [0.8.1] - 2026-02-08

### Fixed

- SessionStart health check silently failing on Node.js 24 — `node -e` inline scripts break because the Bash tool escapes `!` to `\!`, which is invalid in Node 24's TypeScript parser. Moved health check logic to a `.cjs` script file that works on Node 18 through 24+.

## [0.8.0] - 2026-02-08

### Added

- Proactive PR health check notification on session start — reads cached state to show "2 of 15 PRs need attention" without any network calls; configurable via `showHealthCheck` setting
- "Why OSS Autopilot?" competitive comparison section in README

## [0.7.2] - 2026-02-08

### Fixed

- Stale `needs_response` status when contributor has already pushed changes addressing maintainer feedback
  - GitHub's `reviewDecision` stays `changes_requested` until maintainer re-approves, causing false positives
  - Now compares latest commit timestamp against last maintainer comment — if the commit is newer, shows `changes_addressed` instead of `needs_response`
  - New `changes_addressed` status shown in daily digest, dashboard, and JSON output
  - Not counted in `totalNeedingAttention` (not actionable by contributor)

## [0.7.1] - 2026-02-08

### Removed

- Deleted `src/index.ts` — 1,172 lines of dead code from the pre-Commander monolith
- Removed `dotenv` dependency — token detection uses `gh auth token` / `$GITHUB_TOKEN`, not `.env` files

### Fixed

- `package.json` `main` field pointed to non-existent `dist/index.js`, now points to `dist/cli.js`
- State file now written with `0600` permissions (owner-only read/write) for security
- Events array capped at 1,000 entries to prevent unbounded state file growth
- Replaced `any` types in `issue-discovery.ts` with proper `GitHubSearchItem` interface

## [0.7.0] - 2026-02-08

### Added

- Pre-commit hooks enforcing workflow rules from CLAUDE.md:
  - **Version sync check** — blocks commits when `package.json`, `plugin.json`, and README badge versions don't match
  - **No AI attribution** — blocks commits containing "Co-Authored-By: Claude" or similar attribution
  - **No commits on main** — blocks direct commits to `main`/`master` branch
  - **Conventional commit format** — blocks messages without `feat:`, `fix:`, `chore:` etc. prefix

### Fixed

- README version badge stuck at 0.4.1 while actual version was 0.6.1
- CLAUDE.md versioning checklist missing README badge as a required update location

## [0.6.1] - 2026-02-08

### Added

- SessionStart hook for automatic stale bundle rebuild after plugin updates
- Daily update notification — shows when a newer version is available on GitHub
- Version display in `/oss` summary output (e.g., "v0.6.1")

### Fixed

- CLI bundle not rebuilt after `/plugin update` — Step 0.5 only checked file existence, not staleness
- CLI VERSION constant hardcoded at 0.1.0 — now reads from package.json at runtime

## [0.6.0] - 2026-02-08

### Added

- Pre-commit code review step (Step 5.5) in `/oss` workflow — comprehensive quality gate before committing
- New `pre-commit-reviewer` agent for standalone code review
- Parallel dispatch of PR review toolkit agents (code-reviewer, silent-failure-hunter, code-simplifier, pr-test-analyzer) for thorough analysis
- Target repository convention checking (CONTRIBUTING.md, lint configs, test patterns)
- Fix-review-commit loop: address findings, re-review until clean, then commit (with optional manual diff review)
- Conditional dispatch of type-design-analyzer and comment-analyzer for relevant changes
- Fallback to local pre-commit-reviewer agent when PR review toolkit is unavailable

## [0.5.0] - 2026-02-08

### Added

- Track closed PRs from GitHub — queries `is:pr is:closed is:unmerged` to populate `closedWithoutMergeCount` in repo scores
- Recently closed PRs section in daily digest and dashboard — surfaces PRs closed without merge in the last 7 days
- `fetchUserClosedPRCounts()` and `fetchRecentlyClosedPRs()` methods in PRMonitor
- `ClosedPR` type and `recentlyClosedPRs` field in `DailyDigest`
- `recently_closed` actionable issue type for structured output

### Fixed

- Merge rate was always 100% because `closedWithoutMergeCount` was never populated from GitHub
- Closed PRs were invisible — a PR closed by a maintainer would silently vanish from the dashboard

## [0.4.1] - 2026-02-07

### Fixed

- Deduplicate CI check runs by name to prevent superseded failures from incorrectly flagging PRs
  - GitHub's `checks.listForRef` returns all historical runs including re-runs
  - Now keeps only the most recent run per unique check name
  - Fixes false "CI Failing" status when a check is re-run and passes

### Added

- Tests for CI status deduplication logic in `pr-monitor.test.ts`

## [0.4.0] - 2025-02-07

### Added

- Curated issue list integration and post-PR flow continuity
- CHANGELOG.md with reconstructed version history
- Version badge and new README sections: Updating, Troubleshooting, FAQ
- Release process documentation in CONTRIBUTING.md

### Changed

- Synced version across `plugin.json` and `package.json` (both now `0.4.0`)
- README overhaul with improved structure and new user-facing sections

## [0.3.0] - 2025-01-27

### Added

- v2 fresh GitHub fetching architecture — replaces cached state with live GitHub API calls (#27)
- Merged PR counts populated from GitHub with org/owner filtering (#29)
- Rebase detection, action tiers, and new PR status categories in daily check (#30)
- Checklist detection, action hints, and waiting-on-maintainer status (#33)
- Bundled CLI with esbuild for zero-install experience (#34)

### Fixed

- Filter non-actionable CI statuses from capacity assessment (#32)

## [0.2.0] - 2025-01-25

### Added

- Hybrid CLI architecture with action-first UX and human-in-the-loop (#5)
- Plugin marketplace support for `/plugin discovery` (#9)
- CONTRIBUTING.md for new contributors (#16)
- Social preview image

### Changed

- README rewritten to lead with discovery, add adaptive features (#11)
- README cleaned up, linked to CONTRIBUTING.md (#25)

## [0.1.0] - 2025-01-06

### Added

- Initial release of OSS Autopilot
- Interactive features: comment posting, dashboard
- Project guidelines and AI attribution rules
- `/oss` and `/setup-oss` slash commands
- Specialized agents: pr-responder, pr-health-checker, issue-scout, repo-evaluator, contribution-strategist
- TypeScript CLI backend with structured JSON output
- PR monitoring and health checking
- Dashboard HTML generation

[0.11.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.10.1...v0.11.0
[0.10.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.10.0...v0.10.1
[0.10.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.8...v0.9.0
[0.8.8]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.7...v0.8.8
[0.8.7]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.6...v0.8.7
[0.8.6]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.5...v0.8.6
[0.8.5]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.4...v0.8.5
[0.8.4]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.1...v0.8.2
[0.8.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/costajohnt/oss-autopilot/releases/tag/v0.1.0

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

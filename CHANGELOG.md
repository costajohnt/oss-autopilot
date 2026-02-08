# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[0.6.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/costajohnt/oss-autopilot/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/costajohnt/oss-autopilot/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/costajohnt/oss-autopilot/releases/tag/v0.1.0

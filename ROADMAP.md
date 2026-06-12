# Roadmap

> **Maintenance note:** This file is hand-maintained. When an item under Now/Next closes on GitHub, move it to the Shipped section and pull the next item up from the open backlog.

This roadmap reflects the current development priorities for oss-autopilot. Items are derived from [open issues](https://github.com/costajohnt/oss-autopilot/issues) and may shift as the project evolves.

Have an idea? Open a [Discussion](https://github.com/costajohnt/oss-autopilot/discussions) or file an issue.

## Now (next 1-2 weeks)

- [ ] Move canonical issue-scout and repo-evaluator agents into oss-scout ([#1241](https://github.com/costajohnt/oss-autopilot/issues/1241))

## Next (next 1-2 months)

## Later (no fixed timeline)

- [ ] Co-maintainer recruitment — the project is currently solo-maintained (bus factor of 1)

Have an idea? Open a [Discussion](https://github.com/costajohnt/oss-autopilot/discussions) or file an issue.

## Shipped

- [x] Strategy-biased search with a 20% diversity counterweight and surfaced boost/diversity annotations ([#1244](https://github.com/costajohnt/oss-autopilot/issues/1244))
- [x] Fix `list-mark-done` silently no-opping on missing entries — mirrors the list-move-tier contract ([#1406](https://github.com/costajohnt/oss-autopilot/issues/1406))
- [x] Unify the attention taxonomy — one classifier for CLI brief and dashboard, with `stuck_ci` / `dormant_followup` buckets ([#1352](https://github.com/costajohnt/oss-autopilot/issues/1352))
- [x] Deterministic `verify-issue` — real open/closed state and closing-vs-mention PR classification, wired into issue-scout ([#1353](https://github.com/costajohnt/oss-autopilot/issues/1353), [#1354](https://github.com/costajohnt/oss-autopilot/issues/1354))
- [x] Fix `list-move-tier` silently no-opping on missing entries — a URL absent from the list is now an explicit error ([#1355](https://github.com/costajohnt/oss-autopilot/issues/1355))
- [x] Fix preAction bootstrap errors surfacing as unhandled rejections (`parse` vs `parseAsync`) ([#1386](https://github.com/costajohnt/oss-autopilot/issues/1386))
- [x] Stop three more catch sites from swallowing rate-limit errors into degraded results ([#1391](https://github.com/costajohnt/oss-autopilot/issues/1391))
- [x] Add a `guidelines list` subcommand backed by `listGuidelinesRepos()` ([#1393](https://github.com/costajohnt/oss-autopilot/issues/1393))
- [x] Surface `ConcurrencyError` in the dashboard as retryable instead of a generic 500 ([#1397](https://github.com/costajohnt/oss-autopilot/issues/1397))
- [x] Bring README/ARCHITECTURE/ROADMAP counts and status back in sync with the code ([#1379](https://github.com/costajohnt/oss-autopilot/issues/1379))
- [x] Unify skip-list persistence — the `.md` file and `state.skippedIssues` no longer drift ([#992](https://github.com/costajohnt/oss-autopilot/issues/992))
- [x] Audit-v2 follow-up sprint — closed the 15 issues filed by the 2026-04-19 audit ([#993](https://github.com/costajohnt/oss-autopilot/issues/993)–[#1007](https://github.com/costajohnt/oss-autopilot/issues/1007))
- [x] Runtime `--json` contract enforcement — output shapes validated against Zod schemas at runtime ([#965](https://github.com/costajohnt/oss-autopilot/issues/965))
- [x] Per-repo learning from merged PR review feedback ([#867](https://github.com/costajohnt/oss-autopilot/issues/867))
- [x] Contract tests for mutating CLI commands (`track`, `dismiss`, `shelve`, `move`) ([#997](https://github.com/costajohnt/oss-autopilot/issues/997))
- [x] Dashboard live demo for non-dev audiences — 30-min visual walkthrough ([#940](https://github.com/costajohnt/oss-autopilot/issues/940))
- [x] Decompose `issue-discovery.ts` into focused modules ([#356](https://github.com/costajohnt/oss-autopilot/issues/356))
- [x] Add SBOM generation to release workflow ([#359](https://github.com/costajohnt/oss-autopilot/issues/359))
- [x] Add `/oss-help` quick reference command ([#360](https://github.com/costajohnt/oss-autopilot/issues/360))
- [x] Agents cross-reference each other ([#361](https://github.com/costajohnt/oss-autopilot/issues/361))
- [x] Document health-check hook behavior and configuration ([#362](https://github.com/costajohnt/oss-autopilot/issues/362))
- [x] Document curated issue list file format ([#364](https://github.com/costajohnt/oss-autopilot/issues/364))
- [x] Add end-to-end contribution walkthrough ([#365](https://github.com/costajohnt/oss-autopilot/issues/365))
- [x] Document branch protection and RELEASE_TOKEN management ([#366](https://github.com/costajohnt/oss-autopilot/issues/366))
- [x] Add pre-commit-reviewer security scanning ([#367](https://github.com/costajohnt/oss-autopilot/issues/367))
- [x] Add marketplace.json categories and visual assets ([#369](https://github.com/costajohnt/oss-autopilot/issues/369))
- [x] Expand SECURITY.md with full threat model
- [x] Raise CI coverage thresholds to 75%+
- [x] Enable GitHub Discussions and add ROADMAP.md
- [x] Run project linter/formatter before committing
- [x] Require explicit user approval before posting PR comments
- [x] Issue conversation monitoring — track maintainer responses on commented issues
- [x] v2 "Fresh Fetch" architecture — PRs fetched from GitHub on every run, no stale local state
- [x] 7 specialized agents (PR responder, issue scout, CI diagnosis, etc.)
- [x] HTML dashboard generation
- [x] AI policy blocklist for repos that prohibit AI contributions

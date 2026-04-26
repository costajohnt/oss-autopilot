# Roadmap

This roadmap reflects the current development priorities for oss-autopilot. Items are derived from [open issues](https://github.com/costajohnt/oss-autopilot/issues) and may shift as the project evolves.

Have an idea? Open a [Discussion](https://github.com/costajohnt/oss-autopilot/discussions) or file an issue.

## Now (next 1-2 weeks)

- [ ] Unify skip-list persistence — the `.md` file and `state.skippedIssues` currently drift ([#992](https://github.com/costajohnt/oss-autopilot/issues/992))
- [ ] Audit-v2 follow-up sprint — close the 15 issues filed by the 2026-04-19 audit ([#993](https://github.com/costajohnt/oss-autopilot/issues/993)–[#1007](https://github.com/costajohnt/oss-autopilot/issues/1007))

## Next (next 1-2 months)

- [ ] Runtime `--json` contract enforcement — golden-file tests cover the happy path but nothing validates output shape at runtime ([#965](https://github.com/costajohnt/oss-autopilot/issues/965))
- [ ] Per-repo learning from merged PR review feedback — adapt pursue-order signals based on what actually gets merged ([#867](https://github.com/costajohnt/oss-autopilot/issues/867))
- [ ] Contract tests for mutating CLI commands (`track`, `dismiss`, `shelve`, `move`) ([#997](https://github.com/costajohnt/oss-autopilot/issues/997))

## Later (no fixed timeline)

- [ ] 1.0 launch content — blog post, social posts, competitive positioning ([#731](https://github.com/costajohnt/oss-autopilot/issues/731))
- [ ] Dashboard live demo for non-dev audiences — 30-min visual walkthrough ([#940](https://github.com/costajohnt/oss-autopilot/issues/940))
- [ ] Co-maintainer recruitment — the project is currently solo-maintained (bus factor of 1)

Have an idea? Open a [Discussion](https://github.com/costajohnt/oss-autopilot/discussions) or file an issue.

## Completed (Recent)

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

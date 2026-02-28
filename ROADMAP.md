# Roadmap

This roadmap reflects the current development priorities for oss-autopilot. Items are derived from [open issues](https://github.com/costajohnt/oss-autopilot/issues) and may shift as the project evolves.

Have an idea? Open a [Discussion](https://github.com/costajohnt/oss-autopilot/discussions) or file an issue.

## Current Focus

- [ ] Decompose `issue-discovery.ts` — 1,396 lines with 135 conditionals needs splitting into focused modules ([#356](https://github.com/costajohnt/oss-autopilot/issues/356))
- [ ] Add SBOM generation to release workflow ([#359](https://github.com/costajohnt/oss-autopilot/issues/359))
- [ ] Add plugin help command or quick-start tutorial ([#360](https://github.com/costajohnt/oss-autopilot/issues/360))
- [ ] Agents should cross-reference each other for better coordination ([#361](https://github.com/costajohnt/oss-autopilot/issues/361))

## Planned

- [ ] Add pre-commit-reviewer security scanning capabilities ([#367](https://github.com/costajohnt/oss-autopilot/issues/367))
- [ ] Add marketplace.json categories and visual assets ([#369](https://github.com/costajohnt/oss-autopilot/issues/369))
- [ ] Document health-check hook behavior and configuration ([#362](https://github.com/costajohnt/oss-autopilot/issues/362))
- [ ] Document curated issue list file format ([#364](https://github.com/costajohnt/oss-autopilot/issues/364))
- [ ] Add end-to-end contribution walkthrough example ([#365](https://github.com/costajohnt/oss-autopilot/issues/365))
- [ ] Document branch protection rules and RELEASE_TOKEN management ([#366](https://github.com/costajohnt/oss-autopilot/issues/366))

## Completed (Recent)

- [x] Expand SECURITY.md with full threat model
- [x] Raise CI coverage thresholds to 75%+
- [x] Run project linter/formatter before committing
- [x] Require explicit user approval before posting PR comments
- [x] Issue conversation monitoring — track maintainer responses on commented issues
- [x] v2 "Fresh Fetch" architecture — PRs fetched from GitHub on every run, no stale local state
- [x] 7 specialized agents (PR responder, issue scout, CI diagnosis, etc.)
- [x] HTML dashboard generation
- [x] AI policy blocklist for repos that prohibit AI contributions

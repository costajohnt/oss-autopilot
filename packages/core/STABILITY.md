# Stability Policy

This document defines what is covered by semantic versioning in `@oss-autopilot/core`.

## Stable (covered by semver)

Breaking changes to these surfaces will only occur in major version bumps.

### CLI (`oss-autopilot` binary)

- Command names and their `--json` output shape (`{ success, data, error, timestamp }`)
- Exit codes: 0 for success, 1 for errors
- `--json` flag availability on all commands

### Library exports (`@oss-autopilot/core`)

- `@oss-autopilot/core` — `StateManager`, `PRMonitor`, `IssueDiscovery`, `getOctokit`, utility functions
- `@oss-autopilot/core/types` — all exported type definitions
- `@oss-autopilot/core/commands` — `runDaily`, `runSearch`, `runStatus`, `runVet`, and all other `run*` command functions

### State file (`~/.oss-autopilot/state.json`)

- Forward-compatible: new fields may be added without a major bump
- Existing field semantics will not change without a migration and major bump

## Experimental (may change in minor versions)

- Dashboard HTTP server API (`/api/data`, `/api/action`, `/api/refresh` response shapes)
- `DashboardJsonData` internal type
- `computePRsByRepo`, `computeTopRepos`, `getMonthlyData` helper functions
- Text-mode display formatting (`formatSummary`, `printDigest`, `formatBriefSummary`)
- CI analysis internals (`classifyCICheck`, `classifyFailingChecks`)

## Internal (no stability guarantees)

- Anything not exported from the three public entry points
- Test utilities (`test-utils.ts`)
- Build artifacts and bundle structure
- Plugin markdown files (commands, agents, skills, workflows)

# AgentState Schema Audit — v2 to v3

Date: 2026-03-25

## Purpose

Field-by-field audit of `AgentState` before migrating to Gist-based persistence.
Each field is classified as Durable (Gist), Local-only, or Drop.

## Classification

### Durable — Goes in Gist

| Field | Used By | Write Path | Notes |
|-------|---------|------------|-------|
| `config.githubUsername` | Nearly every command | `config.ts`, `init.ts`, `setup.ts` | Core identity |
| `config.maxActivePRs` | `daily-logic.ts` capacity gating | `setup.ts` | Preference |
| `config.dormantThresholdDays` | `pr-monitor.ts` staleness | `setup.ts` | Preference |
| `config.approachingDormantDays` | `pr-monitor.ts` staleness | `setup.ts` | Preference |
| `config.languages` | `issue-discovery.ts` search | `config.ts`, `setup.ts` | Preference |
| `config.labels` | `issue-discovery.ts` search | `config.ts`, `setup.ts` | Preference |
| `config.scope` | `issue-discovery.ts` search | `config.ts`, `setup.ts` | Preference |
| `config.excludeRepos` | `issue-discovery.ts`, `search.ts`, `issue-conversation.ts` | `config.ts` | Preference |
| `config.excludeOrgs` | `issue-conversation.ts` | `config.ts` | Preference |
| `config.trustedProjects` | `issue-vetting.ts`, `repo-score-manager.ts` | Auto from `daily.ts` | Accumulated intelligence |
| `config.minStars` | `issue-discovery.ts`, `dashboard-data.ts`, `github-stats.ts`, `search-phases.ts` | `setup.ts` | Heavily used |
| `config.includeDocIssues` | `issue-discovery.ts` | `setup.ts` | Preference |
| `config.aiPolicyBlocklist` | `search.ts`, `issue-discovery.ts`, `issue-conversation.ts` | `setup.ts` | Blocklist |
| `config.projectCategories` | `issue-vetting.ts`, `issue-discovery.ts` | `setup.ts` | Preference |
| `config.preferredOrgs` | `issue-discovery.ts`, `issue-vetting.ts` | `setup.ts` | Preference |
| `config.shelvedPRUrls` | `daily.ts`, `state.ts`, dashboard | `state.ts` shelve/unshelve | User intent |
| `config.dismissedIssues` | `dashboard-server.ts`, `state.ts` | `state.ts` dismiss/undismiss | User intent |
| `config.statusOverrides` | `daily-logic.ts`, `state.ts` | `state.ts` via `move.ts` | User intent |
| `config.setupComplete` | Gate for all commands | `state.ts` markSetupComplete | Lifecycle |
| `config.squashByDefault` | `draft-first-workflow.md` (plugin layer) | `setup.ts` | Preference |
| `config.maxIssueAgeDays` | `issue-discovery.ts` | No setter (defaults to 90) | Keep with default |
| `config.minRepoScoreThreshold` | `repo-score-manager.ts` | No setter (defaults to 4) | Keep with default |
| `repoScores` | Scoring, vetting, dashboard, stats | `daily.ts` Phase 2, `issue-vetting.ts` | Most important durable field |
| `mergedPRs` | Dashboard, watermark fetch, reconcile | `dashboard-data.ts` via addMergedPRs | Historical ledger |
| `closedPRs` | Dashboard, watermark fetch, reconcile | `dashboard-data.ts` via addClosedPRs | Historical ledger |
| `activeIssues` | `issue-discovery.ts`, `issue-conversation.ts` | `state.ts` addIssue | Work queue |
| `monthlyMergedCounts` | `dashboard-data.ts` charts | `updateMonthlyAnalytics` | Accumulated chart data |
| `monthlyClosedCounts` | `dashboard-data.ts` charts | `updateMonthlyAnalytics` | Accumulated chart data |
| `monthlyOpenedCounts` | `dashboard-data.ts` charts | `updateMonthlyAnalytics` | Accumulated chart data |

### Local-only — Never sync to Gist

| Field | Reason |
|-------|--------|
| `lastDigest` | Large ephemeral snapshot, regenerated each run |
| `lastDigestAt` | Local timestamp for new-PR detection logic |
| `lastRunAt` | Updated every save, machine-local |
| `localRepoCache` | Filesystem paths, machine-specific |
| `config.starredRepos` | API cache with 24h TTL, auto-refreshed |
| `config.starredReposLastFetched` | TTL timestamp for starredRepos |
| `config.issueListPath` | Absolute filesystem path |
| `config.skippedIssuesPath` | Absolute filesystem path |
| `config.localRepoScanPaths` | Filesystem paths, no setter exposed |
| `config.setupCompletedAt` | Written but never read in logic |

### Drop — Remove from schema

| Field | Reason |
|-------|--------|
| `events` | appendEvent() never called in production. Query methods never called. Dead weight. |
| `dailyActivityCounts` | Setter defined but never called in production. Always undefined. |
| `config.showHealthCheck` | Written by setup, never read by any runtime logic. |
| `config.scoreThreshold` | Writable via setup but no runtime consumer in vetting/discovery. |

## New Fields for v3

| Field | Schema | Purpose |
|-------|--------|---------|
| `StoredMergedPR.learningsExtractedAt` | `z.string().optional()` | Track which merged PRs have had review comments analyzed |
| `StoredClosedPR.learningsExtractedAt` | `z.string().optional()` | Same for closed PRs |
| `analyzedIssueConversations` | `z.array(z.object({ url, repo, analyzedAt })).optional()` | Track analyzed issue conversations |

## Infrastructure to Wire Up

`fetchMergedPRsSince` and `fetchClosedPRsSince` are called from `dashboard-data.ts` but NOT from `daily.ts`.
Users who only run `/oss` and never open the dashboard will have empty `mergedPRs`/`closedPRs` arrays.
Wire these into the daily flow so the arrays are always populated.

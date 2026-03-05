# Status Taxonomy Simplification

**Issue:** #563
**Date:** 2026-03-04

## Problem

The current `FetchedPRStatus` has 13 values. In practice, every active PR is either "I need to do something" or "I'm waiting on someone else." The granular statuses (13 competing values) create three problems:

1. **Staleness competes with actionability** — A dormant PR that gets a new maintainer comment stays `dormant` instead of surfacing as actionable.
2. **Redundant waiting states** — `waiting`, `ci_blocked`, and `waiting_on_maintainer` are all "ball in their court."
3. **Over-classification** — When addressing a PR, you'll discover the specifics anyway. The top-level status doesn't need to encode them.

## Design

### Two active statuses

Replace 13 `FetchedPRStatus` values with 2:

- **`needs_addressing`** — Contributor's turn. Something requires action.
- **`waiting_on_maintainer`** — Maintainer's turn. Nothing for the contributor to do.

### Action reason as a separate field

Add `actionReason` to `FetchedPR` to preserve the granular "why":

```typescript
export type ActionReason =
  | 'needs_response'      // Maintainer commented, awaiting reply
  | 'needs_changes'       // Review requested changes
  | 'failing_ci'          // CI checks failing (actionable)
  | 'merge_conflict'      // Conflicts with base branch
  | 'incomplete_checklist' // Unchecked required checkboxes
  // Future (currently reserved):
  | 'ci_not_running'
  | 'needs_rebase'
  | 'missing_required_files';

export type WaitReason =
  | 'pending_review'       // Awaiting initial review (was: healthy, waiting)
  | 'pending_merge'        // Approved, CI passes, waiting for merge
  | 'changes_addressed'    // Pushed commits after feedback, awaiting re-review
  | 'ci_blocked';          // All failing CI is non-actionable (fork/auth/infra)

export interface FetchedPR {
  status: FetchedPRStatus; // 'needs_addressing' | 'waiting_on_maintainer'
  actionReason?: ActionReason;  // Set when status is needs_addressing
  waitReason?: WaitReason;      // Set when status is waiting_on_maintainer
  // ... rest unchanged
}
```

### Staleness as a separate dimension

Replace `healthy`, `approaching_dormant`, `dormant` statuses with a field:

```typescript
export type StalenessTier = 'active' | 'approaching_dormant' | 'dormant';

export interface FetchedPR {
  stalenessTier: StalenessTier;
  // ...
}
```

Staleness no longer competes with actionability. A PR can be both `needs_addressing` (maintainer commented) AND `dormant` (30+ days old overall). The status tells you what to do; staleness tells you how urgent it is.

### Dormant = auto-shelved

- PRs that reach `dormant` staleness tier are automatically shelved.
- Shelving and dormancy converge: both mean "not thinking about this right now."
- The `approaching_dormant` tier serves as a warning before auto-shelving.

### Auto-resurface on meaningful activity

Shelved/dormant PRs automatically resurface as `needs_addressing` when meaningful activity occurs:

**Resurface triggers:**
- New maintainer comment
- New review (approval or changes requested)
- CI starts failing on a previously-passing PR

**Not triggers (noise):**
- Bot comments
- Label changes
- Status checks from non-actionable sources

This is implemented via the existing auto-unshelve logic in the daily command, extended to check for these specific conditions.

## Migration

### FetchedPRStatus union

Before (13 values):
```
needs_response | failing_ci | ci_blocked | ci_not_running | merge_conflict |
needs_rebase | missing_required_files | incomplete_checklist | needs_changes |
waiting | waiting_on_maintainer | healthy | approaching_dormant | dormant
```

After (2 values):
```
needs_addressing | waiting_on_maintainer
```

### DailyDigest arrays

Before (13 category arrays):
```
prsNeedingResponse, ciFailingPRs, ciBlockedPRs, ciNotRunningPRs,
mergeConflictPRs, needsRebasePRs, missingRequiredFilesPRs,
incompleteChecklistPRs, needsChangesPRs, waitingOnMaintainerPRs,
approachingDormant, dormantPRs, healthyPRs
```

After (2 category arrays):
```
needsAddressingPRs, waitingOnMaintainerPRs
```

The granular breakdown is still available by filtering `openPRs` by `actionReason` or `waitReason`.

### Display

The display layer (`display-utils.ts`, `daily-logic.ts`, dashboard) uses `actionReason`/`waitReason` to show context-specific descriptions. The top-level sections become:

- **Needs Addressing** (red accent) — grouped by actionReason
- **Waiting on Maintainer** (blue accent) — grouped by waitReason
- **Shelved** (muted) — collapsed section

### Health check (`.cjs`)

Simplifies to: `needsAddressing` count + `waitingOnMaintainer` count.

## Files touched

- `packages/core/src/core/types.ts` — New types, simplified FetchedPRStatus
- `packages/core/src/core/pr-monitor.ts` — `determineStatus()` returns 2 statuses + reason fields
- `packages/core/src/core/display-utils.ts` — STATUS_DISPLAY keyed by reason, not status
- `packages/core/src/core/daily-logic.ts` — Simplified digest sections, constants
- `packages/core/src/formatters/json.ts` — Simplified DailyDigestCompact
- `packages/core/src/commands/dashboard-templates.ts` — HTML dashboard
- `packages/dashboard/src/` — Interactive dashboard (types, utils, components)
- `.claude-plugin/scripts/health-check.cjs` — Simplified health check
- `workflows/work-through-issues.md` — Simplified dispatch table
- All test files for the above

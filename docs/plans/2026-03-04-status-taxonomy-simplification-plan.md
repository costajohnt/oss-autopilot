# Status Taxonomy Simplification — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Collapse 13 `FetchedPRStatus` values to 2 (`needs_addressing`, `waiting_on_maintainer`) with granular reasons as separate fields, and staleness as an orthogonal dimension.

**Architecture:** The `FetchedPRStatus` union shrinks from 13 to 2 values. Three new fields on `FetchedPR` (`actionReason`, `waitReason`, `stalenessTier`) preserve the granular classification. `DailyDigest` collapses 13 category arrays into 2. Display/rendering layers key off reason fields instead of status. Dashboard and health-check update accordingly.

**Tech Stack:** TypeScript, vitest, Preact (dashboard SPA), esbuild (bundle)

---

### Task 1: Update core types

**Files:**
- Modify: `packages/core/src/core/types.ts`

**Step 1: Add new types and update FetchedPRStatus**

Add these new types before `FetchedPRStatus`:

```typescript
/** Granular reason why a PR needs addressing (contributor's turn). */
export type ActionReason =
  | 'needs_response'
  | 'needs_changes'
  | 'failing_ci'
  | 'merge_conflict'
  | 'incomplete_checklist'
  | 'ci_not_running'
  | 'needs_rebase'
  | 'missing_required_files';

/** Granular reason why a PR is waiting on the maintainer. */
export type WaitReason =
  | 'pending_review'
  | 'pending_merge'
  | 'changes_addressed'
  | 'ci_blocked';

/** How stale is the PR based on days since activity. Orthogonal to status. */
export type StalenessTier = 'active' | 'approaching_dormant' | 'dormant';
```

Replace the `FetchedPRStatus` union:

```typescript
export type FetchedPRStatus = 'needs_addressing' | 'waiting_on_maintainer';
```

Update the JSDoc accordingly.

**Step 2: Add new fields to FetchedPR**

Add after the `status` field in the `FetchedPR` interface:

```typescript
/** Granular reason for the status. Set when status is 'needs_addressing'. */
actionReason?: ActionReason;
/** Granular reason for the status. Set when status is 'waiting_on_maintainer'. */
waitReason?: WaitReason;
/** How stale the PR is based on activity age. Independent of status. */
stalenessTier: StalenessTier;
```

**Step 3: Simplify DailyDigest**

Replace the 13 category arrays in `DailyDigest` with 2:

```typescript
/** PRs where the contributor needs to take action. */
needsAddressingPRs: FetchedPR[];
/** PRs waiting on the maintainer. */
waitingOnMaintainerPRs: FetchedPR[];
```

Remove: `prsNeedingResponse`, `ciFailingPRs`, `ciBlockedPRs`, `ciNotRunningPRs`, `mergeConflictPRs`, `needsRebasePRs`, `missingRequiredFilesPRs`, `incompleteChecklistPRs`, `needsChangesPRs`, `approachingDormant`, `dormantPRs`, `healthyPRs`.

Keep: `openPRs`, `recentlyClosedPRs`, `recentlyMergedPRs`, `shelvedPRs`, `autoUnshelvedPRs`, `summary`.

**Step 4: Run type-check to see all downstream breakages**

Run: `cd packages/core && npx tsc --noEmit 2>&1 | head -100`

This will show every file that needs updating. Don't fix yet — just verify the type changes are correct.

**Step 5: Commit types**

```bash
git add packages/core/src/core/types.ts
git commit -m "refactor: simplify FetchedPRStatus to 2 states with reason fields (#563)"
```

---

### Task 2: Update test utilities

**Files:**
- Modify: `packages/core/src/core/test-utils.ts`

**Step 1: Update makeFetchedPR defaults**

Change default `status` to `'waiting_on_maintainer'`, add `stalenessTier: 'active'`, `waitReason: 'pending_review'`:

```typescript
export function makeFetchedPR(overrides: Partial<FetchedPR> = {}): FetchedPR {
  const repo = overrides.repo ?? 'owner/repo';
  const number = overrides.number ?? 1;
  return {
    id: 1,
    url: `https://github.com/${repo}/pull/${number}`,
    repo,
    number,
    title: 'Test PR',
    status: 'waiting_on_maintainer',
    displayLabel: '[Waiting on Maintainer]',
    displayDescription: 'Awaiting review',
    stalenessTier: 'active',
    waitReason: 'pending_review',
    createdAt: '2025-06-01T00:00:00Z',
    updatedAt: '2025-06-15T00:00:00Z',
    daysSinceActivity: 2,
    ciStatus: 'passing',
    failingCheckNames: [],
    classifiedChecks: [],
    hasMergeConflict: false,
    reviewDecision: 'approved',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    ...overrides,
  };
}
```

**Step 2: Update makeDailyDigest defaults**

Replace 13 category arrays with 2:

```typescript
export function makeDailyDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: '2025-06-20T00:00:00Z',
    openPRs: [],
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: 0,
      totalNeedingAttention: 0,
      totalMergedAllTime: 0,
      mergeRate: 0,
    },
    ...overrides,
  };
}
```

**Step 3: Commit**

```bash
git add packages/core/src/core/test-utils.ts
git commit -m "refactor: update test factories for simplified status taxonomy (#563)"
```

---

### Task 3: Update PRMonitor.determineStatus and generateDigest

**Files:**
- Modify: `packages/core/src/core/pr-monitor.ts`

**Step 1: Update determineStatus return type and logic**

Change return type to `{ status: FetchedPRStatus; actionReason?: ActionReason; waitReason?: WaitReason; stalenessTier: StalenessTier }`.

The logic stays the same but returns the new shape:

```typescript
private determineStatus(input: DetermineStatusInput): {
  status: FetchedPRStatus;
  actionReason?: ActionReason;
  waitReason?: WaitReason;
  stalenessTier: StalenessTier;
} {
  // ... same input destructuring ...

  // Compute staleness independently
  let stalenessTier: StalenessTier = 'active';
  if (daysSinceActivity >= dormantThreshold) stalenessTier = 'dormant';
  else if (daysSinceActivity >= approachingThreshold) stalenessTier = 'approaching_dormant';

  // Same priority logic, but return new shape
  if (hasUnrespondedComment) {
    if (latestCommitDate && lastMaintainerCommentDate && this.isCommitAfterComment(latestCommitDate, lastMaintainerCommentDate)) {
      if (latestChangesRequestedDate && latestCommitDate < latestChangesRequestedDate) {
        return { status: 'needs_addressing', actionReason: 'needs_response', stalenessTier };
      }
      if (ciStatus === 'failing' && hasActionableCIFailure) {
        return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
      }
      return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
    }
    return { status: 'needs_addressing', actionReason: 'needs_response', stalenessTier };
  }

  if (reviewDecision === 'changes_requested' && latestChangesRequestedDate) {
    if (!latestCommitDate || latestCommitDate < latestChangesRequestedDate) {
      return { status: 'needs_addressing', actionReason: 'needs_changes', stalenessTier };
    }
    if (ciStatus === 'failing' && hasActionableCIFailure) {
      return { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier };
    }
    return { status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier };
  }

  if (ciStatus === 'failing') {
    return hasActionableCIFailure
      ? { status: 'needs_addressing', actionReason: 'failing_ci', stalenessTier }
      : { status: 'waiting_on_maintainer', waitReason: 'ci_blocked', stalenessTier };
  }

  if (hasMergeConflict) {
    return { status: 'needs_addressing', actionReason: 'merge_conflict', stalenessTier };
  }

  if (hasIncompleteChecklist) {
    return { status: 'needs_addressing', actionReason: 'incomplete_checklist', stalenessTier };
  }

  // Approved and CI passing = waiting for merge
  if (reviewDecision === 'approved' && (ciStatus === 'passing' || ciStatus === 'unknown')) {
    return { status: 'waiting_on_maintainer', waitReason: 'pending_merge', stalenessTier };
  }

  // Default: waiting for review
  return { status: 'waiting_on_maintainer', waitReason: 'pending_review', stalenessTier };
}
```

**Step 2: Update fetchPRDetails to use new determineStatus shape**

Where `determineStatus` is called, destructure the result and pass all fields to `buildFetchedPR`:

```typescript
const { status, actionReason, waitReason, stalenessTier } = this.determineStatus({...});

return this.buildFetchedPR({
  // ... existing fields ...
  status,
  actionReason,
  waitReason,
  stalenessTier,
  // ...
});
```

**Step 3: Update generateDigest**

Replace 13 filters with 2:

```typescript
const needsAddressingPRs = prs.filter((pr) => pr.status === 'needs_addressing');
const waitingOnMaintainerPRs = prs.filter((pr) => pr.status === 'waiting_on_maintainer');

return {
  generatedAt: now,
  openPRs: prs,
  needsAddressingPRs,
  waitingOnMaintainerPRs,
  // ... rest stays same ...
  summary: {
    totalActivePRs: prs.length,
    totalNeedingAttention: needsAddressingPRs.length,
    totalMergedAllTime: stats.mergedPRs,
    mergeRate: parseFloat(stats.mergeRate),
  },
};
```

**Step 4: Update sort priority in fetchUserOpenPRs**

Simplify the priority map:

```typescript
const statusPriority: Record<FetchedPRStatus, number> = {
  needs_addressing: 0,
  waiting_on_maintainer: 1,
};
```

**Step 5: Commit**

```bash
git add packages/core/src/core/pr-monitor.ts
git commit -m "refactor: determineStatus returns 2 statuses + reason + staleness (#563)"
```

---

### Task 4: Update display-utils

**Files:**
- Modify: `packages/core/src/core/display-utils.ts`

**Step 1: Rewrite STATUS_DISPLAY to use reason fields**

The display now keys off `actionReason`/`waitReason` instead of status:

```typescript
import { FetchedPR, FetchedPRStatus, ActionReason, WaitReason } from './types.js';

const ACTION_DISPLAY: Record<ActionReason, { label: string; description: (pr: FetchedPR) => string }> = {
  needs_response: {
    label: '[Needs Response]',
    description: (pr) => pr.lastMaintainerComment ? `@${pr.lastMaintainerComment.author} commented` : 'Maintainer awaiting response',
  },
  needs_changes: {
    label: '[Needs Changes]',
    description: () => 'Review requested changes — push commits to address',
  },
  failing_ci: {
    label: '[CI Failing]',
    description: (pr) => { /* same as current */ },
  },
  merge_conflict: {
    label: '[Merge Conflict]',
    description: () => 'PR has merge conflicts with the base branch',
  },
  incomplete_checklist: {
    label: '[Incomplete Checklist]',
    description: (pr) => pr.checklistStats ? `${pr.checklistStats.checked}/${pr.checklistStats.total} items checked` : 'PR body has unchecked required checkboxes',
  },
  ci_not_running: {
    label: '[CI Not Running]',
    description: () => 'No CI checks have been triggered',
  },
  needs_rebase: {
    label: '[Needs Rebase]',
    description: () => 'PR branch is significantly behind upstream',
  },
  missing_required_files: {
    label: '[Missing Files]',
    description: (pr) => pr.missingRequiredFiles ? `Missing: ${pr.missingRequiredFiles.join(', ')}` : 'Required files are missing',
  },
};

const WAIT_DISPLAY: Record<WaitReason, { label: string; description: (pr: FetchedPR) => string }> = {
  pending_review: {
    label: '[Waiting on Maintainer]',
    description: () => 'Awaiting review',
  },
  pending_merge: {
    label: '[Waiting on Maintainer]',
    description: () => 'Approved and CI passes — waiting for merge',
  },
  changes_addressed: {
    label: '[Waiting on Maintainer]',
    description: (pr) => {
      if (pr.hasUnrespondedComment && pr.lastMaintainerComment) {
        return `Changes addressed — waiting for @${pr.lastMaintainerComment.author} to re-review`;
      }
      return 'Changes addressed — awaiting re-review';
    },
  },
  ci_blocked: {
    label: '[CI Blocked]',
    description: (pr) => {
      const checks = pr.classifiedChecks || [];
      if (checks.length > 0 && checks.every((c) => c.category !== 'actionable')) {
        const categories = [...new Set(checks.map((c) => c.category))];
        return `All failing checks are non-actionable (${categories.join(', ')})`;
      }
      return 'CI checks are failing but no action is needed from you';
    },
  },
};
```

Update `computeDisplayLabel` to use the reason-based maps:

```typescript
export function computeDisplayLabel(pr: FetchedPR): { displayLabel: string; displayDescription: string } {
  if (pr.status === 'needs_addressing' && pr.actionReason) {
    const entry = ACTION_DISPLAY[pr.actionReason];
    if (entry) return { displayLabel: entry.label, displayDescription: entry.description(pr) };
  }
  if (pr.status === 'waiting_on_maintainer' && pr.waitReason) {
    const entry = WAIT_DISPLAY[pr.waitReason];
    if (entry) return { displayLabel: entry.label, displayDescription: entry.description(pr) };
  }
  // Fallback
  if (pr.status === 'needs_addressing') return { displayLabel: '[Needs Addressing]', displayDescription: 'Action required' };
  return { displayLabel: '[Waiting on Maintainer]', displayDescription: 'Awaiting maintainer action' };
}
```

**Step 2: Commit**

```bash
git add packages/core/src/core/display-utils.ts
git commit -m "refactor: display labels keyed by actionReason/waitReason (#563)"
```

---

### Task 5: Update daily-logic

**Files:**
- Modify: `packages/core/src/core/daily-logic.ts`

**Step 1: Simplify constants**

```typescript
export const CRITICAL_STATUSES: ReadonlySet<FetchedPRStatus> = new Set(['needs_addressing']);

export const ACTIVE_MAINTAINER_STATUSES: ReadonlySet<FetchedPRStatus> = new Set([
  'waiting_on_maintainer',
  'needs_addressing',
]);

export const STALE_STATUSES: ReadonlySet<StalenessTier> = new Set(['dormant', 'approaching_dormant']);
```

Note: `STALE_STATUSES` now uses `StalenessTier` instead of `FetchedPRStatus`. Update `computeRepoSignals` to check `pr.stalenessTier` instead of `pr.status`.

**Step 2: Update collectActionableIssues**

Use `actionReason` to classify:

```typescript
export function collectActionableIssues(prs: FetchedPR[], snoozedUrls: Set<string> = new Set()): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const actionPRs = prs.filter((pr) => pr.status === 'needs_addressing');

  // Order by actionReason priority
  const reasonOrder: ActionReason[] = ['needs_response', 'needs_changes', 'failing_ci', 'merge_conflict', 'incomplete_checklist'];

  for (const reason of reasonOrder) {
    for (const pr of actionPRs) {
      if (pr.actionReason !== reason) continue;
      if (reason === 'failing_ci' && snoozedUrls.has(pr.url)) continue;

      let label: string;
      switch (reason) {
        case 'failing_ci': {
          const checkInfo = pr.failingCheckNames.length > 0 ? ` (${pr.failingCheckNames.join(', ')})` : '';
          label = `[CI Failing${checkInfo}]`;
          break;
        }
        case 'incomplete_checklist': {
          const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : '';
          label = `[Incomplete Checklist${stats}]`;
          break;
        }
        default:
          label = `[${reason.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}]`;
      }

      issues.push({ type: reason === 'failing_ci' ? 'ci_failing' : reason as ActionableIssueType, pr, label });
    }
  }

  return issues;
}
```

**Step 3: Update formatSummary and printDigest**

Replace the 13-section rendering with 2 sections + sub-grouping by reason. The "Needs Addressing" section groups PRs by `actionReason`. The "Waiting on Maintainer" section groups PRs by `waitReason`.

Key change in `formatSummary`:
- Replace individual sections (CI Failing, Merge Conflicts, Needs Response, etc.) with a single "Needs Addressing" section that groups by reason
- Replace individual waiting sections with a single "Waiting on Maintainer" section
- Use `digest.needsAddressingPRs` and `digest.waitingOnMaintainerPRs`

**Step 4: Commit**

```bash
git add packages/core/src/core/daily-logic.ts
git commit -m "refactor: daily-logic uses simplified status taxonomy (#563)"
```

---

### Task 6: Update JSON formatter

**Files:**
- Modify: `packages/core/src/formatters/json.ts`

**Step 1: Simplify DailyDigestCompact**

Replace 13 category URL arrays with 2:

```typescript
export interface DailyDigestCompact {
  generatedAt: string;
  openPRs: FetchedPR[];
  needsAddressingPRs: string[];
  waitingOnMaintainerPRs: string[];
  recentlyClosedPRs: DailyDigest['recentlyClosedPRs'];
  recentlyMergedPRs: DailyDigest['recentlyMergedPRs'];
  shelvedPRs: ShelvedPRRef[];
  autoUnshelvedPRs: ShelvedPRRef[];
  summary: DailyDigest['summary'];
}
```

**Step 2: Update deduplicateDigest**

```typescript
export function deduplicateDigest(digest: DailyDigest): DailyDigestCompact {
  const toUrls = (prs: FetchedPR[]): string[] => prs.map((pr) => pr.url);
  return {
    generatedAt: digest.generatedAt,
    openPRs: digest.openPRs,
    needsAddressingPRs: toUrls(digest.needsAddressingPRs),
    waitingOnMaintainerPRs: toUrls(digest.waitingOnMaintainerPRs),
    recentlyClosedPRs: digest.recentlyClosedPRs,
    recentlyMergedPRs: digest.recentlyMergedPRs,
    shelvedPRs: digest.shelvedPRs,
    autoUnshelvedPRs: digest.autoUnshelvedPRs,
    summary: digest.summary,
  };
}
```

**Step 3: Commit**

```bash
git add packages/core/src/formatters/json.ts
git commit -m "refactor: simplify DailyDigestCompact for 2-status taxonomy (#563)"
```

---

### Task 7: Update all tests

**Files:**
- Modify: `packages/core/src/core/pr-monitor.test.ts`
- Modify: `packages/core/src/core/display-utils.test.ts`
- Modify: `packages/core/src/core/daily-logic.test.ts`
- Modify: `packages/core/src/commands/daily.test.ts`
- Modify: `packages/core/src/commands/daily-orchestration.test.ts`
- Modify: `packages/core/src/commands/startup.test.ts`
- Modify: `packages/core/src/commands/dashboard-data.test.ts`
- Modify: `packages/core/src/commands/dashboard-server.test.ts`
- Modify: `packages/core/src/formatters/json.test.ts`

**Step 1: Update pr-monitor.test.ts**

All `determineStatus` tests change from expecting a single status string to expecting an object `{ status, actionReason?, waitReason?, stalenessTier }`. For example:
- `'needs_response'` → `{ status: 'needs_addressing', actionReason: 'needs_response', stalenessTier: 'active' }`
- `'waiting_on_maintainer'` → `{ status: 'waiting_on_maintainer', waitReason: 'changes_addressed', stalenessTier: 'active' }`
- `'dormant'` → `{ status: 'waiting_on_maintainer', waitReason: 'pending_review', stalenessTier: 'dormant' }`

Key test changes:
- "dormant" tests now return `stalenessTier: 'dormant'` with a real status
- "approaching_dormant" tests return `stalenessTier: 'approaching_dormant'` with a real status
- "healthy" tests return `{ status: 'waiting_on_maintainer', waitReason: 'pending_review' }`
- All `FetchedPR` mock objects need `stalenessTier` field
- `generateDigest` tests use `needsAddressingPRs`/`waitingOnMaintainerPRs` instead of 13 arrays

**Step 2: Update display-utils.test.ts**

Tests check label/description based on `actionReason`/`waitReason` instead of status.

**Step 3: Update daily-logic.test.ts**

- `CRITICAL_STATUSES` test: size = 1, contains `'needs_addressing'`
- `ACTIVE_MAINTAINER_STATUSES` test: size = 2
- `STALE_STATUSES` test: now checks `StalenessTier` values
- `collectActionableIssues` tests: PRs use `actionReason` to trigger collection
- `computeRepoSignals` tests: use `stalenessTier` for staleness checks

**Step 4: Update command test files**

All files that use `makeDailyDigest()` — remove references to removed category arrays. All files that create `FetchedPR` mocks add `stalenessTier`.

**Step 5: Run full test suite**

Run: `cd packages/core && npx vitest run`

Fix any remaining failures.

**Step 6: Commit**

```bash
git add packages/core/src
git commit -m "test: update all tests for 2-status taxonomy (#563)"
```

---

### Task 8: Update dashboard templates (HTML)

**Files:**
- Modify: `packages/core/src/commands/dashboard-templates.ts`

**Step 1: Simplify HTML dashboard**

- Replace 13-status filter dropdown with 2 statuses + reason sub-filters
- Replace per-status badge logic with `actionReason`/`waitReason` badges
- Simplify health items from 13+ categories to 2 sections
- Update `statusColor()` in the embedded JS to handle 2 statuses
- Update filter logic to filter by `status` and optionally by `actionReason`/`waitReason`

**Step 2: Run dashboard template tests**

Run: `cd packages/core && npx vitest run src/commands/dashboard-formatters.test.ts`

**Step 3: Commit**

```bash
git add packages/core/src/commands/dashboard-templates.ts
git commit -m "refactor: HTML dashboard for simplified status taxonomy (#563)"
```

---

### Task 9: Update dashboard SPA

**Files:**
- Modify: `packages/dashboard/src/types.ts` (re-exports follow core changes automatically)
- Modify: `packages/dashboard/src/utils.ts`
- Modify: `packages/dashboard/src/components/filter-bar.tsx`
- Modify: `packages/dashboard/src/components/pr-list.tsx`
- Modify: `packages/dashboard/src/utils.test.ts`

**Step 1: Update utils.ts statusColor**

```typescript
export function statusColor(status: FetchedPRStatus | string): string {
  switch (status) {
    case 'needs_addressing':
      return 'var(--accent-error)';
    case 'waiting_on_maintainer':
      return 'var(--accent-info)';
    default:
      return 'var(--text-muted)';
  }
}
```

**Step 2: Update filter-bar.tsx STATUS_LABELS**

```typescript
const STATUS_LABELS: Record<FetchedPRStatus, string> = {
  needs_addressing: 'Needs Addressing',
  waiting_on_maintainer: 'Waiting on Maintainer',
};
```

**Step 3: Update pr-list.tsx section sets**

```typescript
const ACTION_REQUIRED: Set<FetchedPRStatus> = new Set(['needs_addressing']);
const WAITING: Set<FetchedPRStatus> = new Set(['waiting_on_maintainer']);
```

Remove the `HEALTHY` set (no longer a separate status).

**Step 4: Run dashboard tests**

Run: `cd packages/dashboard && npx vitest run`

**Step 5: Commit**

```bash
git add packages/dashboard/src
git commit -m "refactor: dashboard SPA for simplified status taxonomy (#563)"
```

---

### Task 10: Update health-check and workflows

**Files:**
- Modify: `.claude-plugin/scripts/health-check.cjs`
- Modify: `workflows/work-through-issues.md`

**Step 1: Simplify health-check.cjs**

Replace category counting with:

```javascript
const d = state.lastDigest;
const total = d.summary.totalActivePRs || 0;
if (total === 0) process.exit(0);
const segments = [];
const needsAddressing = (d.needsAddressingPRs || []).length;
const waitMaintainer = (d.waitingOnMaintainerPRs || []).length;
if (needsAddressing > 0) segments.push(needsAddressing + ' need addressing');
if (waitMaintainer > 0) segments.push(waitMaintainer + ' waiting on maintainer');
```

**Step 2: Update work-through-issues.md dispatch table**

Replace the multi-row dispatch table with 2 rows:
- `needs_addressing` → dispatch PR responder or CI diagnosis agent based on `actionReason`
- `waiting_on_maintainer` → Info only

**Step 3: Run full test suite across all packages**

Run: `pnpm test`

Ensure all 1600+ tests pass.

**Step 4: Commit**

```bash
git add .claude-plugin/scripts/health-check.cjs workflows/work-through-issues.md
git commit -m "refactor: health-check and workflows for simplified taxonomy (#563)"
```

---

### Task 11: Final verification and bundle

**Step 1: Run complete test suite**

Run: `pnpm test`

All tests must pass across core, dashboard, and MCP server packages.

**Step 2: Rebuild bundle**

Run: `pnpm run bundle`

Verify it succeeds.

**Step 3: Type-check all packages**

Run: `cd packages/core && npx tsc --noEmit && cd ../dashboard && npx tsc --noEmit`

**Step 4: Commit bundle and any remaining fixes**

```bash
git add -A
git commit -m "chore: rebuild bundle for simplified status taxonomy (#563)"
```

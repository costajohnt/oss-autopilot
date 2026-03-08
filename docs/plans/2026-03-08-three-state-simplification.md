# Three-State PR Simplification Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Simplify PR management to three states (Need Attention, Waiting on Maintainer, Shelved) by removing snooze, removing PR dismiss, and adding a unified `move` command.

**Architecture:** Remove snooze feature entirely. Restrict dismiss to issues only. Add `move <url> <target>` command that composes existing `shelvePR()`, `unshelvePR()`, `setStatusOverride()`, `clearStatusOverride()` methods. Keep shelve/unshelve/override as aliases. Strip dead state on load. Bump MCP server to v2.0.0.

**Tech Stack:** TypeScript, vitest, pnpm monorepo

---

### Task 1: Baseline — Record current test count

**Step 1: Run tests and record count**

Run: `cd packages/core && npx vitest run 2>&1 | tail -5`

Baseline: 1591 tests passing, 58 test files.

---

### Task 2: Remove snooze from types and state

**Files:**
- Modify: `packages/core/src/core/types.ts`
- Modify: `packages/core/src/core/state.ts`

**Step 1: Remove `SnoozeInfo` type from `types.ts`**

In `packages/core/src/core/types.ts`:
- Delete the `SnoozeInfo` interface (lines 513-518):
  ```typescript
  export interface SnoozeInfo {
    reason: string;
    snoozedAt: string;
    expiresAt: string;
  }
  ```
- Delete `snoozedPRs?: Record<string, SnoozeInfo>;` from `AgentConfig` (line 603)
- Delete `snoozedPRs: {},` from `DEFAULT_CONFIG` (line 676)

**Step 2: Remove snooze methods from `state.ts`**

In `packages/core/src/core/state.ts`:
- Remove import of `SnoozeInfo` from the type imports (line 18)
- Remove `snoozedPRs: {},` from `MIGRATION_STATE` config (line 233)
- Delete `snoozePR()` method (lines 967-985)
- Delete `unsnoozePR()` method (lines 992-998)
- Delete `isSnoozed()` method (lines 1005-1014)
- Delete `getSnoozeInfo()` method (lines 1021-1023)
- Delete `expireSnoozes()` method (lines 1029-1043)

**Step 3: Add state cleanup in `loadState()`**

In the `load()` method of `StateManager`, after loading the state object, add cleanup to strip dead `snoozedPRs` data:

```typescript
// Strip removed features from persisted state (three-state simplification)
if (state.config.snoozedPRs) {
  delete (state.config as Record<string, unknown>).snoozedPRs;
}
```

Also strip PR URLs from `dismissedIssues` (since PR dismiss is being removed):

```typescript
if (state.config.dismissedIssues) {
  const PR_URL_RE = /\/pull\/\d+$/;
  for (const url of Object.keys(state.config.dismissedIssues)) {
    if (PR_URL_RE.test(url)) {
      delete state.config.dismissedIssues[url];
    }
  }
}
```

**Step 4: Verify build**

Run: `cd packages/core && npx tsc --noEmit`
Expected: Compilation errors from files that still reference snooze. This is expected — subsequent tasks fix them.

**Step 5: Commit**

```
refactor: remove SnoozeInfo type and snooze methods from StateManager
```

---

### Task 3: Remove snooze command and CLI registration

**Files:**
- Delete: `packages/core/src/commands/snooze.ts`
- Delete: `packages/core/src/commands/snooze.test.ts`
- Modify: `packages/core/src/commands/index.ts`
- Modify: `packages/core/src/cli-registry.ts`

**Step 1: Delete snooze command files**

Delete `packages/core/src/commands/snooze.ts` and `packages/core/src/commands/snooze.test.ts`.

**Step 2: Remove snooze exports from `index.ts`**

In `packages/core/src/commands/index.ts`:
- Delete line 48-49 (runSnooze export)
- Delete line 50-51 (runUnsnooze export)
- Delete line 96 (SnoozeOutput, UnsnoozeOutput type export)

**Step 3: Remove snooze CLI registrations from `cli-registry.ts`**

In `packages/core/src/cli-registry.ts`:
- Delete the `snooze` command registration block (lines 851-889)
- Delete the `unsnooze` command registration block (lines 891-913)

**Step 4: Commit**

```
refactor: remove snooze command and CLI registration
```

---

### Task 4: Remove snooze from daily logic

**Files:**
- Modify: `packages/core/src/commands/daily.ts`
- Modify: `packages/core/src/core/daily-logic.ts`
- Modify: `packages/core/src/core/daily-logic.test.ts`
- Modify: `packages/core/src/commands/daily-orchestration.test.ts`

**Step 1: Remove snooze expiration from `daily.ts`**

In `packages/core/src/commands/daily.ts`:
- Delete the snooze expiration block in Phase 4 (lines 367-378):
  ```typescript
  const expiredSnoozes = stateManager.expireSnoozes();
  ...
  ```
- Delete the snoozed URLs collection block in Phase 5 (lines 478-480):
  ```typescript
  const snoozedUrls = new Set(
    Object.keys(stateManager.getState().config.snoozedPRs ?? {}).filter((url) => stateManager.isSnoozed(url)),
  );
  ```
- Update the `collectActionableIssues()` call (line 512) to remove the `snoozedUrls` argument.

**Step 2: Remove `snoozedUrls` parameter from `collectActionableIssues()` in `daily-logic.ts`**

In `packages/core/src/core/daily-logic.ts`:
- Change function signature from `collectActionableIssues(prs: FetchedPR[], snoozedUrls: Set<string> = new Set(), lastDigestAt?: string)` to `collectActionableIssues(prs: FetchedPR[], lastDigestAt?: string)`
- Delete the snooze filtering logic (line 269): `if (reason === 'failing_ci' && snoozedUrls.has(pr.url)) continue;`

**Step 3: Update tests**

In `packages/core/src/core/daily-logic.test.ts`:
- Delete the snooze-related test at line 267-278 ("skips snoozed PRs for CI failures")
- Delete the snooze-related test at line 280-286 ("includes snoozed PRs for non-CI issue types")
- Update any remaining `collectActionableIssues()` calls to use new 2-parameter signature

In `packages/core/src/commands/daily-orchestration.test.ts`:
- Remove `mockExpireSnoozes` mock setup (line 37)
- Remove `mockIsSnoozed` mock setup (line 43)
- Remove mock function assignments for `expireSnoozes` and `isSnoozed` (lines 78, 84)
- Remove `snoozedPRs: {}` from test state configs (lines 159 etc.)
- Remove default mock return values for snooze mocks (lines 210-213)
- Delete test "should call expireSnoozes once per daily check" (lines 291-294)
- Delete the entire suite "executeDailyCheck() — snoozed PR filtering" (lines 508-576)

**Step 4: Verify build and tests**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`
Expected: All passing (test count will decrease by the removed snooze tests).

**Step 5: Commit**

```
refactor: remove snooze from daily logic and tests
```

---

### Task 5: Remove snooze state tests

**Files:**
- Modify: `packages/core/src/core/state.test.ts`

**Step 1: Remove snooze test suite**

Delete the `describe('snoozePR / unsnoozePR / isSnoozed / expireSnoozes', ...)` block (lines 733-857).

**Step 2: Verify tests**

Run: `cd packages/core && npx vitest run src/core/state.test.ts`

**Step 3: Commit**

```
refactor: remove snooze state tests
```

---

### Task 6: Remove PR dismiss from daily logic

**Files:**
- Modify: `packages/core/src/commands/daily.ts`
- Modify: `packages/core/src/commands/daily-orchestration.test.ts`

**Step 1: Remove PR dismiss filtering from `daily.ts`**

In `packages/core/src/commands/daily.ts`, Phase 5 (`generateDigestOutput`):
- Delete the PR dismiss filtering block (lines 481-502) that filters `nonDismissedPRs`
- The variable `activePRsForDigest` (or equivalent) should now use `activePRs` directly without dismiss filtering
- Keep the save-state-if-changed logic but only for issue auto-undismiss

**Step 2: Update orchestration tests**

In `packages/core/src/commands/daily-orchestration.test.ts`:
- Delete the "dismissed PR URL filtering (#416, #468)" test suite (lines 582-642)
- Remove `mockGetIssueDismissedAt` and `mockUndismissIssue` mock cleanup related to PRs

**Step 3: Verify tests**

Run: `cd packages/core && npx vitest run`

**Step 4: Commit**

```
refactor: remove PR dismiss filtering from daily check
```

---

### Task 7: Restrict dismiss command to issues only

**Files:**
- Modify: `packages/core/src/commands/dismiss.ts`
- Modify: `packages/core/src/commands/dismiss.test.ts`
- Modify: `packages/core/src/cli-registry.ts`

**Step 1: Change URL validation in `dismiss.ts`**

In `packages/core/src/commands/dismiss.ts`:
- Change import from `ISSUE_OR_PR_URL_PATTERN` to `ISSUE_URL_PATTERN`
- Update `validateGitHubUrl()` calls in both `runDismiss()` and `runUndismiss()` to use `ISSUE_URL_PATTERN` and entity type `'issue'`
- Update module docstring to say "issue notifications" not "issue and PR notifications"

**Step 2: Update CLI descriptions in `cli-registry.ts`**

- Change dismiss description from "Dismiss notifications for an issue or PR" to "Dismiss notifications for an issue (resurfaces on new activity)"
- Change undismiss description from "Undismiss an issue or PR" to "Undismiss an issue (re-enable notifications)"
- Update output messages to say "issue" not "issue or PR"

**Step 3: Update tests in `dismiss.test.ts`**

- Change tests that use PR URLs to use issue URLs
- Add a test that PR URLs are rejected with a validation error
- Update test descriptions

**Step 4: Verify tests**

Run: `cd packages/core && npx vitest run src/commands/dismiss.test.ts`

**Step 5: Commit**

```
feat: restrict dismiss command to issues only

PR dismiss is replaced by the `move` command's three-state model.
```

---

### Task 8: Create `move` command

**Files:**
- Create: `packages/core/src/commands/move.ts`
- Create: `packages/core/src/commands/move.test.ts`
- Modify: `packages/core/src/commands/index.ts`
- Modify: `packages/core/src/cli-registry.ts`

**Step 1: Create `move.ts`**

Create `packages/core/src/commands/move.ts`:

```typescript
/**
 * Move command — transition a PR between the three states:
 * attention, waiting, shelved, or auto (reset to computed status).
 */

import { getStateManager } from '../core/index.js';
import type { FetchedPRStatus } from '../core/types.js';
import { PR_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export type MoveTarget = 'attention' | 'waiting' | 'shelved' | 'auto';

export const VALID_TARGETS: readonly MoveTarget[] = ['attention', 'waiting', 'shelved', 'auto'] as const;

export interface MoveOutput {
  url: string;
  target: MoveTarget;
  /** Human-readable description of what happened. */
  description: string;
}

const TARGET_TO_STATUS: Partial<Record<MoveTarget, FetchedPRStatus>> = {
  attention: 'needs_addressing',
  waiting: 'waiting_on_maintainer',
};

export async function runMove(options: { prUrl: string; target: string }): Promise<MoveOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const target = options.target as MoveTarget;
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(`Invalid target "${options.target}". Must be one of: ${VALID_TARGETS.join(', ')}`);
  }

  const stateManager = getStateManager();

  switch (target) {
    case 'attention':
    case 'waiting': {
      const status = TARGET_TO_STATUS[target]!;
      const lastActivityAt = new Date().toISOString();
      stateManager.setStatusOverride(options.prUrl, status, lastActivityAt);
      stateManager.unshelvePR(options.prUrl);
      stateManager.save();
      return {
        url: options.prUrl,
        target,
        description: `Moved to ${target === 'attention' ? 'Need Attention' : 'Waiting on Maintainer'}`,
      };
    }
    case 'shelved': {
      stateManager.shelvePR(options.prUrl);
      stateManager.clearStatusOverride(options.prUrl);
      stateManager.save();
      return {
        url: options.prUrl,
        target,
        description: 'Shelved — excluded from capacity and actionable items',
      };
    }
    case 'auto': {
      const clearedOverride = stateManager.clearStatusOverride(options.prUrl);
      const unshelved = stateManager.unshelvePR(options.prUrl);
      if (clearedOverride || unshelved) {
        stateManager.save();
      }
      return {
        url: options.prUrl,
        target,
        description: 'Reset to computed status',
      };
    }
  }
}
```

**Step 2: Create `move.test.ts`**

Create `packages/core/src/commands/move.test.ts` with tests for:
- Each target: attention, waiting, shelved, auto
- Invalid target rejection
- Invalid URL rejection
- `attention` calls `setStatusOverride` + `unshelvePR` + save
- `waiting` calls `setStatusOverride` + `unshelvePR` + save
- `shelved` calls `shelvePR` + `clearStatusOverride` + save
- `auto` calls `clearStatusOverride` + `unshelvePR`, saves only if something changed
- `auto` with nothing to clear: does not save

**Step 3: Add exports to `index.ts`**

In `packages/core/src/commands/index.ts`:
- Add `export { runMove } from './move.js';` in the PR Management section
- Add `export type { MoveOutput, MoveTarget } from './move.js';` in the output types section

**Step 4: Register CLI command in `cli-registry.ts`**

Add `move` command registration:
- Command: `move <pr-url> <target>`
- Description: "Move a PR between states: attention, waiting, shelved, or auto (reset)"
- localOnly: true
- Import and call `runMove()`
- Output: the `description` field from the result

**Step 5: Make shelve/unshelve delegate to move**

Update `packages/core/src/cli-registry.ts`:
- Change `shelve` registration to call `runMove({ prUrl, target: 'shelved' })` instead of `runShelve()`
- Change `unshelve` registration to call `runMove({ prUrl, target: 'auto' })` instead of `runUnshelve()`
- Change `override` registration to call `runMove()` with mapped target
- Change `clear-override` registration to call `runMove({ prUrl, target: 'auto' })`
- Mark `override` and `clear-override` as hidden (add `hidden: true` to their metadata)

**Step 6: Verify build and tests**

Run: `cd packages/core && npx tsc --noEmit && npx vitest run`

**Step 7: Commit**

```
feat: add unified `move` command for three-state PR management

Replaces override/clear-override with move <url> attention|waiting|shelved|auto.
shelve/unshelve become aliases. Closes #XXX
```

---

### Task 9: Update dashboard types and actions

**Files:**
- Modify: `packages/dashboard/src/types.ts`
- Modify: `packages/dashboard/src/components/action-bar.tsx`
- Modify: `packages/dashboard/src/components/action-bar.test.tsx`
- Modify: `packages/core/src/commands/dashboard-server.ts`
- Modify: `packages/core/src/commands/dashboard-server.test.ts`

**Step 1: Update dashboard types**

In `packages/dashboard/src/types.ts`:
- Change `ActionType` from `'shelve' | 'unshelve' | 'override_status' | 'dismiss_issue_response'` to `'move' | 'dismiss_issue_response'`
- Update `ActionRequest` to have `target?: 'attention' | 'waiting' | 'shelved' | 'auto'` instead of `status?`

**Step 2: Update action-bar.tsx**

In `packages/dashboard/src/components/action-bar.tsx`:
- Change shelve/unshelve button to send `{ action: 'move', url, target: isShelved ? 'auto' : 'shelved' }`
- Change override button to send `{ action: 'move', url, target: pr.status === 'needs_addressing' ? 'waiting' : 'attention' }`

**Step 3: Update dashboard-server.ts**

In `packages/core/src/commands/dashboard-server.ts`:
- Update `ActionRequest` type to include `'move'` and remove `'shelve' | 'unshelve' | 'override_status'`
- Update `VALID_ACTIONS` set
- Update the action handler switch to handle `'move'` by delegating to `runMove()`
- Remove the separate shelve/unshelve/override_status cases

**Step 4: Update tests**

Update `action-bar.test.tsx` and `dashboard-server.test.ts` to use the new `move` action.

**Step 5: Verify tests**

Run: `pnpm test`

**Step 6: Commit**

```
refactor: update dashboard to use unified move action
```

---

### Task 10: Update MCP server

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/tools.test.ts`
- Modify: `packages/mcp-server/src/resources.ts`
- Modify: `packages/mcp-server/README.md`
- Modify: `packages/mcp-server/package.json` (version bump)

**Step 1: Update tools.ts**

In `packages/mcp-server/src/tools.ts`:
- Remove imports for `runSnooze`, `runUnsnooze`
- Add import for `runMove`
- Delete `snooze` tool registration (lines 340-353)
- Delete `unsnooze` tool registration (lines 355-366)
- Add `move` tool registration:
  ```typescript
  server.registerTool(
    'move',
    {
      description: 'Move a PR between states: attention (need attention), waiting (waiting on maintainer), shelved (hidden), or auto (reset to computed status).',
      inputSchema: {
        prUrl: z.string().describe('Full GitHub PR URL'),
        target: z.enum(['attention', 'waiting', 'shelved', 'auto']).describe('Target state'),
      },
    },
    wrapTool(runMove),
  );
  ```
- Update `dismiss` tool description from "issue or PR" to "issue"
- Update `undismiss` tool description from "issue or PR" to "issue"
- Update `status` tool description to remove "snoozed PRs"

**Step 2: Update resources.ts**

In `packages/mcp-server/src/resources.ts`:
- Update resource descriptions to remove references to "snoozed PRs"

**Step 3: Update tools.test.ts**

- Update tool name list (remove `snooze`, `unsnooze`, add `move`)
- Update tool count expectation (21 → 20 tools: removed 2 snooze, added 1 move)
- Update or add schema validation test for `move` tool
- Remove schema validation tests for snooze tool

**Step 4: Bump version to 2.0.0**

In `packages/mcp-server/package.json`:
- This will be handled by release-please with a `feat!:` or `BREAKING CHANGE:` commit footer

**Step 5: Update README.md**

- Update tool count
- Remove snooze/unsnooze from tool list
- Add move to tool list
- Update dismiss/undismiss descriptions

**Step 6: Verify tests**

Run: `cd packages/mcp-server && npx vitest run`

**Step 7: Commit**

```
feat!: replace snooze/unsnooze MCP tools with unified move tool

BREAKING CHANGE: Removed `snooze` and `unsnooze` tools. Use `move` with
target `attention`, `waiting`, `shelved`, or `auto` instead. Dismiss now
only accepts issue URLs.
```

---

### Task 11: Update documentation

**Files:**
- Modify: `ARCHITECTURE.md`
- Modify: `README.md`
- Modify: `workflows/reference.md`
- Modify: `commands/oss.md`

**Step 1: Update ARCHITECTURE.md**

- Remove `snooze / unsnooze` from command registry table
- Add `move` to command registry table
- Update state storage section: remove `config.snoozedPRs`, update `config.dismissedIssues` to say "issues only"
- Update `dismiss / undismiss` description to say "issues" not "issues/PRs"

**Step 2: Update README.md**

- Update MCP tool count (21 → 20)
- Update tool list: remove snooze/unsnooze, add move
- Update dismiss/undismiss descriptions

**Step 3: Update workflows/reference.md**

- Remove snooze/unsnooze CLI examples
- Add move CLI examples
- Update dismiss to say issues only

**Step 4: Update commands/oss.md**

- Remove any references to snoozing
- Update dismiss documentation to reflect issues-only behavior
- Add `move` command documentation

**Step 5: Commit**

```
docs: update documentation for three-state PR model
```

---

### Task 12: Add state cleanup test

**Files:**
- Modify: `packages/core/src/core/state.test.ts`

**Step 1: Add test for dead state cleanup**

Add a test that verifies:
- Loading state with `snoozedPRs` in config strips it
- Loading state with PR URLs in `dismissedIssues` strips them (keeps issue URLs)

**Step 2: Verify tests**

Run: `cd packages/core && npx vitest run src/core/state.test.ts`

**Step 3: Commit**

```
test: add state cleanup tests for removed snooze and PR dismiss
```

---

### Task 13: Final verification

**Step 1: Run full test suite**

Run: `cd packages/core && npx vitest run`
Verify: Total test count is baseline (1591) minus removed tests plus new tests. The exact delta:
- Removed: snooze tests (~18 in state.test.ts, ~8 in snooze.test.ts, ~4 in daily-logic.test.ts, ~6 in daily-orchestration.test.ts, ~3 in tools.test.ts) ≈ ~39
- Removed: PR dismiss tests (~4 in daily-orchestration.test.ts, ~2 in dismiss.test.ts) ≈ ~6
- Added: move command tests (~8-10), state cleanup tests (~3), dismiss PR rejection test (~1) ≈ ~12-14

**Step 2: Run bundle**

Run: `pnpm run bundle`
Verify: Bundle builds without errors.

**Step 3: Run MCP tests**

Run: `cd packages/mcp-server && npx vitest run`
Verify: All passing.

**Step 4: Run dashboard tests**

Run: `cd packages/dashboard && npx vitest run`
Verify: All passing.

**Step 5: Push and open PR**

Branch: `feature/three-state-pr-simplification`

PR title: `feat!: simplify PR management to three-state model`

PR description should note:
- Three states: Need Attention, Waiting on Maintainer, Shelved
- Unified `move` command replaces override/clear-override
- Snooze feature removed entirely
- PR dismiss removed (issue dismiss unchanged)
- MCP breaking change: snooze/unsnooze tools removed, move tool added
- Dead state (snoozedPRs, dismissed PR URLs) cleaned up on load
- shelve/unshelve/override kept as CLI aliases

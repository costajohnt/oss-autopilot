# Decompose StateManager Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Decompose `StateManager` (1,382 lines) into focused sub-modules, bringing it under 400 lines while preserving the public API.

**Architecture:** Extract two heavy responsibility groups into standalone modules: (1) `state-persistence.ts` for file I/O, locking, backup, migration; (2) `repo-score-manager.ts` for scoring formula, repo queries, and stats. StateManager becomes a thin coordinator that delegates to these modules while retaining lightweight CRUD operations (shelve, dismiss, override, config, events, issues). Also raises branch coverage threshold from 65% to 75% (#619).

**Tech Stack:** TypeScript, vitest, Node.js fs module

**Issues:** #612 (decompose StateManager), #619 (raise branch coverage threshold)

---

### Task 1: Extract `state-persistence.ts`

**Files:**
- Create: `packages/core/src/core/state-persistence.ts`
- Modify: `packages/core/src/core/state.ts`

**Step 1: Create `state-persistence.ts` with all persistence functions**

Move these from `state.ts`:
- Free functions: `isLockStale`, `acquireLock`, `releaseLock`, `atomicWriteFileSync`, `migrateV1ToV2`
- Constants: `CURRENT_STATE_VERSION`, `LOCK_TIMEOUT_MS`, `LEGACY_STATE_FILE`, `LEGACY_BACKUP_DIR`
- Private methods extracted as standalone functions: `loadState`, `tryRestoreFromBackup`, `isValidState`, `createFreshState`, `saveState`, `cleanupBackups`

The persistence functions become stateless utilities that accept/return `AgentState` objects:

```typescript
// state-persistence.ts
export function loadState(inMemoryOnly: boolean): AgentState { ... }
export function saveState(state: AgentState, inMemoryOnly: boolean): number | undefined { ... }
// Returns new lastLoadedMtimeMs, or undefined for in-memory mode
export function reloadStateIfChanged(lastLoadedMtimeMs: number | undefined, inMemoryOnly: boolean): { state: AgentState; mtimeMs: number | undefined } | null { ... }
// Returns null if no reload needed

// Already free functions, just move them:
export function acquireLock(lockPath: string): void { ... }
export function releaseLock(lockPath: string): void { ... }
export function atomicWriteFileSync(filePath: string, data: string, mode?: number): void { ... }
```

**Step 2: Update `state.ts` to import from `state-persistence.ts`**

Replace the persistence code in StateManager with delegation:

```typescript
import { loadState, saveState, reloadStateIfChanged, acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';

// In constructor:
this.state = loadState(this.inMemoryOnly);

// In save():
save(): void {
  this.state.lastRunAt = new Date().toISOString();
  const mtimeMs = saveState(this.state, this.inMemoryOnly);
  if (mtimeMs !== undefined) this.lastLoadedMtimeMs = mtimeMs;
}

// In reloadIfChanged():
reloadIfChanged(): boolean {
  const result = reloadStateIfChanged(this.lastLoadedMtimeMs, this.inMemoryOnly);
  if (!result) return false;
  this.state = result.state;
  this.lastLoadedMtimeMs = result.mtimeMs;
  return true;
}
```

**Step 3: Re-export `acquireLock`, `releaseLock`, `atomicWriteFileSync` from `state.ts`**

These are currently exported from `state.ts` and used by tests. Keep re-exporting for backward compatibility:

```typescript
export { acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';
```

**Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/core/state.test.ts`
Expected: All tests pass (public API unchanged, imports preserved via re-exports)

**Step 5: Commit**

```
refactor: extract state-persistence.ts from StateManager

Move file I/O, locking, backup, migration, and state validation
into a standalone module. StateManager delegates to stateless
persistence functions instead of containing them directly.
```

---

### Task 2: Extract `repo-score-manager.ts`

**Files:**
- Create: `packages/core/src/core/repo-score-manager.ts`
- Modify: `packages/core/src/core/state.ts`

**Step 1: Create `repo-score-manager.ts` with all repo scoring logic**

Move these from `state.ts`:
- Constants: `SCORE_TTL_MS`
- Private methods as standalone: `createDefaultRepoScore`, `calculateScore`
- Public methods as standalone functions accepting `AgentState`:
  - `getRepoScore(state, repo)`
  - `updateRepoScore(state, repo, updates)` — mutates state.repoScores in place
  - `incrementMergedCount(state, repo)`
  - `incrementClosedCount(state, repo)`
  - `markRepoHostile(state, repo)`
  - `getReposWithMergedPRs(state)`
  - `getReposWithOpenPRs(state)`
  - `getHighScoringRepos(state, minScore?)`
  - `getLowScoringRepos(state, maxScore?)`
  - `getStats(state)` + `Stats` interface

```typescript
// repo-score-manager.ts
import { AgentState, RepoScore, RepoScoreUpdate, isBelowMinStars } from './types.js';

export function calculateScore(repoScore: RepoScore): number { ... }
export function updateRepoScore(state: AgentState, repo: string, updates: RepoScoreUpdate): void { ... }
export function getRepoScore(state: AgentState, repo: string): RepoScore | undefined { ... }
export function incrementMergedCount(state: AgentState, repo: string): void { ... }
export function incrementClosedCount(state: AgentState, repo: string): void { ... }
export function markRepoHostile(state: AgentState, repo: string): void { ... }
export function getReposWithMergedPRs(state: AgentState): string[] { ... }
export function getReposWithOpenPRs(state: AgentState): string[] { ... }
export function getHighScoringRepos(state: AgentState, minScore?: number): string[] { ... }
export function getLowScoringRepos(state: AgentState, maxScore?: number): string[] { ... }
export function getStats(state: AgentState): Stats { ... }

export interface Stats { ... }
```

**Step 2: Update `StateManager` in `state.ts` to delegate to repo-score functions**

Keep the methods on StateManager (for backward compat) but delegate:

```typescript
import * as repoScoring from './repo-score-manager.js';

// Example delegations:
getRepoScore(repo: string): RepoScore | undefined {
  return repoScoring.getRepoScore(this.state, repo);
}

updateRepoScore(repo: string, updates: RepoScoreUpdate): void {
  repoScoring.updateRepoScore(this.state, repo, updates);
}

getStats(): Stats {
  return repoScoring.getStats(this.state);
}
// ... etc for all repo scoring methods
```

**Step 3: Re-export `Stats` from `state.ts`**

```typescript
export type { Stats } from './repo-score-manager.js';
```

**Step 4: Run tests**

Run: `cd packages/core && npx vitest run src/core/state.test.ts`
Expected: All tests pass

**Step 5: Commit**

```
refactor: extract repo-score-manager.ts from StateManager

Move scoring formula, repo queries, and aggregate stats
into a standalone module with stateless functions. StateManager
delegates to these functions, keeping the public API unchanged.
```

---

### Task 3: Add co-located tests for new modules

**Files:**
- Create: `packages/core/src/core/state-persistence.test.ts`
- Create: `packages/core/src/core/repo-score-manager.test.ts`

**Step 1: Create `state-persistence.test.ts`**

Move/copy the relevant test blocks from `state.test.ts`:
- `describe('Concurrent State Write Protection')` — atomicWriteFileSync, acquireLock/releaseLock tests
- `describe('StateManager file-system persistence (save / load)')` — all file persistence tests

Update imports to use `state-persistence.js` directly for the free functions. Keep the StateManager integration tests that use `new StateManager(false)` in `state.test.ts` since they test the integration.

Actually, the cleaner approach: the persistence tests that test free functions (`atomicWriteFileSync`, `acquireLock`, `releaseLock`) move to `state-persistence.test.ts`. Tests that use `new StateManager(false)` stay in `state.test.ts` since they test integration.

**Step 2: Create `repo-score-manager.test.ts`**

Add focused tests for the extracted functions, testing them directly without going through StateManager. Import functions from `repo-score-manager.js` and test with plain `AgentState` objects.

Key tests:
- `calculateScore` — all the existing scoring formula tests, but calling the function directly
- `updateRepoScore` — partial updates, signal merging
- `getReposWithMergedPRs` / `getReposWithOpenPRs` / `getHighScoringRepos` / `getLowScoringRepos`
- `getStats` — aggregate stats with star filtering

**Step 3: Update `state.test.ts`**

- Remove the free-function persistence tests that moved
- Keep all StateManager integration tests (they verify delegation works correctly)
- Add import for `Stats` from `repo-score-manager.js` if needed

**Step 4: Run all tests**

Run: `cd packages/core && npx vitest run`
Expected: All tests pass

**Step 5: Commit**

```
test: add co-located tests for extracted state modules
```

---

### Task 4: Update exports and raise coverage threshold

**Files:**
- Modify: `packages/core/src/core/index.ts`
- Modify: `packages/core/vitest.config.ts`

**Step 1: Export new modules from `index.ts`**

Add exports for the new modules so library consumers can access them:

```typescript
export { acquireLock, releaseLock, atomicWriteFileSync } from './state-persistence.js';
export {
  calculateScore,
  getStats,
  type Stats,
} from './repo-score-manager.js';
```

Note: `acquireLock`, `releaseLock`, `atomicWriteFileSync` are already exported via `state.ts` re-exports. Check if `index.ts` currently re-exports them from `state.ts` — if so, update the source to `state-persistence.js` to avoid double re-export.

**Step 2: Raise branch coverage threshold (#619)**

In `packages/core/vitest.config.ts`:

```typescript
thresholds: {
  statements: 75,
  branches: 75,  // was 65
  functions: 75,
  lines: 75,
}
```

**Step 3: Run full test suite with coverage**

Run: `cd packages/core && npx vitest run --coverage`
Expected: All tests pass, all coverage thresholds met

**Step 4: Bundle check**

Run: `pnpm run bundle`
Expected: Bundle builds without errors

**Step 5: Commit**

```
chore: update exports and raise branch coverage threshold to 75%

Closes #619.
```

---

### Task 5: Final verification

**Step 1: Run full test suite**

Run: `pnpm test`

**Step 2: Verify line counts**

Run: `wc -l packages/core/src/core/state.ts packages/core/src/core/state-persistence.ts packages/core/src/core/repo-score-manager.ts`

Expected: `state.ts` under 400 lines

**Step 3: Verify bundle**

Run: `pnpm run bundle && GITHUB_TOKEN=$(gh auth token) node packages/core/dist/cli.bundle.cjs status --json`

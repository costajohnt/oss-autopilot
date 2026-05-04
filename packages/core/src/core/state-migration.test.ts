/**
 * Tests for StateManager v1→v2 migration, legacy cleanup, and schema validation
 * (extracted from state.test.ts)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateManager } from './state.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── File-System Persistence Mock Setup ──────────────────────────────────────
//
// Module-level variable shared between the vi.mock factory and test helpers.
// Each describe block resets this in beforeEach / afterEach. The mock redirects
// getStatePath / getBackupDir / getDataDir away from ~/.oss-autopilot/ so every
// file-system persistence test operates in a throwaway temp directory.
// ─────────────────────────────────────────────────────────────────────────────

let mockTmpDir = '';

vi.mock('./paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./paths.js')>();
  return {
    ...actual,
    getDataDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return mockTmpDir;
    },
    getStatePath: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      if (!fs.existsSync(mockTmpDir)) {
        fs.mkdirSync(mockTmpDir, { recursive: true, mode: 0o700 });
      }
      return path.join(mockTmpDir, 'state.json');
    },
    getBackupDir: () => {
      if (!mockTmpDir) throw new Error('mockTmpDir not set');
      const backupDir = path.join(mockTmpDir, 'backups');
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
      }
      return backupDir;
    },
  };
});

// ─── Helper functions ─────────────────────────────────────────────────────────

function makeBaseConfig(): Record<string, unknown> {
  return {
    setupComplete: false,
    maxActivePRs: 10,
    dormantThresholdDays: 30,
    approachingDormantDays: 25,
    maxIssueAgeDays: 90,
    languages: ['typescript'],
    labels: ['good first issue'],
    excludeRepos: [],
    trustedProjects: [],
    githubUsername: '',
    minRepoScoreThreshold: 4,
    starredRepos: [],
    squashByDefault: true,
    minStars: 50,
    includeDocIssues: true,
    aiPolicyBlocklist: [],
    shelvedPRUrls: [],
    dismissedIssues: {},
  };
}

function makeCurrentState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    activeIssues: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: makeBaseConfig(),
    lastRunAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeV1State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    activePRs: [],
    activeIssues: [],
    dormantPRs: [],
    mergedPRs: [],
    closedPRs: [],
    repoScores: {},
    config: makeBaseConfig(),
    events: [],
    lastRunAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Helper: build a minimal legacy PR object for v1 migration tests ─────────
function makeLegacyPR(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    url: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Test PR',
    status: 'merged',
    activityStatus: 'active',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    lastChecked: '2024-01-01T00:00:00Z',
    lastActivityAt: '2024-01-01T00:00:00Z',
    daysSinceActivity: 0,
    hasUnreadComments: false,
    reviewCommentCount: 0,
    commitCount: 1,
    ...overrides,
  };
}

describe('StateManager v1 → v2 migration', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-migration-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should migrate v1 state to v2 on load and update version on disk', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeV1State()), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(4);

    // Verify migration was persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(onDisk.version).toBe(4);
  });

  it('should preserve config when migrating from v1 to v2', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const v1 = makeV1State();
    (v1.config as Record<string, unknown>)['githubUsername'] = 'migrated-user';
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().config.githubUsername).toBe('migrated-user');
  });

  it('should migrate v1 state to v2 and drop legacy PR arrays', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const v1 = makeV1State({
      activePRs: [{ id: 1, url: 'https://github.com/owner/repo/pull/1', repo: 'owner/repo', number: 1, title: 'Test' }],
    });
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    // v2 migration upgrades version and PR arrays are no longer part of AgentState
    expect(sm.getState().version).toBe(4);
  });

  it('should create repo scores from mergedPRs found in v1 state', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const mergedPR = {
      id: 10,
      url: 'https://github.com/facebook/react/pull/10',
      repo: 'facebook/react',
      number: 10,
      title: 'Merged PR',
      status: 'merged',
      activityStatus: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      lastChecked: '2024-01-01T00:00:00Z',
      lastActivityAt: '2024-01-01T00:00:00Z',
      daysSinceActivity: 0,
      hasUnreadComments: false,
      reviewCommentCount: 0,
      commitCount: 1,
    };
    const v1 = makeV1State({ mergedPRs: [mergedPR] });
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    // Migration should create a repo score entry for the repo that had a merged PR
    expect(sm.getState().repoScores['facebook/react']).toBeDefined();
  });

  it('should create repo scores from closedPRs found in v1 state', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const closedPR = {
      id: 20,
      url: 'https://github.com/vuejs/vue/pull/20',
      repo: 'vuejs/vue',
      number: 20,
      title: 'Closed PR',
      status: 'closed',
      activityStatus: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      lastChecked: '2024-01-01T00:00:00Z',
      lastActivityAt: '2024-01-01T00:00:00Z',
      daysSinceActivity: 0,
      hasUnreadComments: false,
      reviewCommentCount: 0,
      commitCount: 1,
    };
    const v1 = makeV1State({ closedPRs: [closedPR] });
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().repoScores['vuejs/vue']).toBeDefined();
  });

  it('should not overwrite existing repo scores from v1 state during migration', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const existingScore = {
      'owner/repo': {
        repo: 'owner/repo',
        score: 9,
        mergedPRCount: 5,
        closedWithoutMergeCount: 0,
        avgResponseDays: null,
        lastEvaluatedAt: '2024-01-01T00:00:00Z',
        signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
      },
    };
    const mergedPR = {
      id: 30,
      url: 'https://github.com/owner/repo/pull/30',
      repo: 'owner/repo',
      number: 30,
      title: 'Another Merged PR',
      status: 'merged',
      activityStatus: 'active',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
      lastChecked: '2024-01-01T00:00:00Z',
      lastActivityAt: '2024-01-01T00:00:00Z',
      daysSinceActivity: 0,
      hasUnreadComments: false,
      reviewCommentCount: 0,
      commitCount: 1,
    };
    const v1 = makeV1State({ repoScores: existingScore, mergedPRs: [mergedPR] });
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    // The pre-existing score should be preserved, not replaced with a default
    expect(sm.getState().repoScores['owner/repo'].score).toBe(9);
    expect(sm.getState().repoScores['owner/repo'].mergedPRCount).toBe(5);
  });

  it('should migrate v1 backup to v2 when restoring from backup', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    // Backup is a valid v1 state
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'),
      JSON.stringify(makeV1State()),
      { mode: 0o600 },
    );

    const sm = new StateManager(false);
    // Should have been migrated to v3 during restore (v1 -> v2 -> v3 chain)
    expect(sm.getState().version).toBe(4);
  });
});

// ── v3 → v4 migration (#867) ─────────────────────────────────────────────────
describe('StateManager v3 → v4 migration', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-migration-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('migrates a v3 state with stored PRs to v4 without dropping data', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const v3State = {
      version: 3,
      config: makeBaseConfig(),
      activeIssues: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      mergedPRs: [
        {
          url: 'https://github.com/a/b/pull/1',
          title: 'old merged',
          mergedAt: '2026-01-01T00:00:00Z',
          learningsExtractedAt: '2026-02-01T00:00:00Z',
        },
      ],
      closedPRs: [{ url: 'https://github.com/a/b/pull/2', title: 'old closed', closedAt: '2026-01-15T00:00:00Z' }],
    };
    fs.writeFileSync(statePath, JSON.stringify(v3State), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    expect(state.version).toBe(4);
    expect(state.mergedPRs?.[0].url).toBe('https://github.com/a/b/pull/1');
    expect(state.mergedPRs?.[0].learningsExtractedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.mergedPRs?.[0].commentsFetchedAt).toBeUndefined();
    expect(state.closedPRs?.[0].url).toBe('https://github.com/a/b/pull/2');
    expect(state.closedPRs?.[0].commentsFetchedAt).toBeUndefined();

    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(onDisk.version).toBe(4);
  });
});

// ── #1208 M8: state migration test gaps ─────────────────────────────────────
// The audit flagged 4 missing test cases in state-migration coverage.

describe('state migration: v2 → v4 (chained, file-based) (#1208 M8)', () => {
  // Existing tests cover v1→v4 (line 137) and v3→v4 (line 294), and the
  // gist-state-store suite covers v2→v4 indirectly. The local file-load
  // path was missing a direct v2-start test — users who paused upgrades
  // from a v0.60-era client would hit this path.

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-v2v4-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('chains v2 → v3 → v4 on the local file-load path', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Minimal v2 state — no mergedPRs/closedPRs (those are v2-era optional)
    const v2State = {
      version: 2,
      config: makeBaseConfig(),
      activeIssues: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      mergedPRs: [],
      closedPRs: [],
    };
    fs.writeFileSync(statePath, JSON.stringify(v2State), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    expect(state.version).toBe(4);
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(onDisk.version).toBe(4);
  });
});

describe('state migration: v4 idempotency (#1208 M8)', () => {
  // No test verified that loading an already-v4 state file does NOT trigger
  // an unnecessary disk rewrite. Without idempotency, the load path would
  // bump the file's mtime on every run and could thrash backups.

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-idem-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('does not rewrite an already-v4 state file on load', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const v4State = {
      version: 4,
      config: makeBaseConfig(),
      activeIssues: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      mergedPRs: [],
      closedPRs: [],
    };
    fs.writeFileSync(statePath, JSON.stringify(v4State, null, 2), { mode: 0o600 });
    const mtimeBefore = fs.statSync(statePath).mtimeMs;

    // Wait a tick so mtime would visibly change if the file is rewritten
    const start = Date.now();
    while (Date.now() - start < 20) {
      // busy-wait briefly
    }

    new StateManager(false);

    const mtimeAfter = fs.statSync(statePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('migrateV3ToV4 field preservation (#1208 M8)', () => {
  // migrateV3ToV4 is essentially a no-op except for bumping the version.
  // A field-preservation test guards against an accidental destructive
  // rewrite (e.g. someone adding `delete record.someField` later).

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-preserve-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('preserves all stored PR fields when migrating v3 → v4', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // v3 state with rich PR data — every field below should survive
    const v3State = {
      version: 3,
      config: makeBaseConfig(),
      activeIssues: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      repoScores: {
        'a/b': {
          repo: 'a/b',
          score: 5,
          mergedPRCount: 3,
          closedWithoutMergeCount: 1,
          avgResponseDays: 2,
          lastEvaluatedAt: '2026-01-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
          stargazersCount: 100,
          language: 'typescript',
        },
      },
      mergedPRs: [
        {
          url: 'https://github.com/a/b/pull/1',
          title: 'old merged',
          mergedAt: '2026-01-01T00:00:00Z',
          learningsExtractedAt: '2026-02-01T00:00:00Z',
        },
      ],
      closedPRs: [],
      monthlyMergedCounts: { '2026-01': 5 },
    };
    fs.writeFileSync(statePath, JSON.stringify(v3State), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // Every input field should round-trip
    expect(state.repoScores['a/b'].score).toBe(5);
    expect(state.repoScores['a/b'].stargazersCount).toBe(100);
    expect(state.repoScores['a/b'].language).toBe('typescript');
    expect(state.mergedPRs?.[0].learningsExtractedAt).toBe('2026-02-01T00:00:00Z');
    expect(state.monthlyMergedCounts?.['2026-01']).toBe(5);
  });
});

// ── Legacy state cleanup on load ────────────────────────────────────────────
describe('legacy state cleanup on load', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-cleanup-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('strips snoozedPRs from config on load', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const stateData = makeCurrentState();
    // Inject legacy snoozedPRs field into config
    (stateData.config as Record<string, unknown>).snoozedPRs = {
      'https://github.com/owner/repo/pull/1': '2025-02-01T00:00:00Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(stateData), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // Zod strips unknown keys in memory — snoozedPRs is absent from parsed state
    expect((state.config as unknown as Record<string, unknown>).snoozedPRs).toBeUndefined();

    // Note: the stale field persists on disk until the next saveState() call.
    // Unlike the old isValidState() cleanup, Zod stripping is in-memory only.
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(onDisk.config.snoozedPRs).toBeDefined();
  });

  it('strips PR URLs from dismissedIssues on load', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const stateData = makeCurrentState();
    (stateData.config as Record<string, unknown>).dismissedIssues = {
      'https://github.com/owner/repo/issues/1': '2025-01-10T00:00:00Z',
      'https://github.com/owner/repo/pull/42': '2025-01-11T00:00:00Z',
      'https://github.com/other/project/issues/5': '2025-01-12T00:00:00Z',
      'https://github.com/other/project/pull/99': '2025-01-13T00:00:00Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(stateData), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // PR URLs should be removed
    expect(state.config.dismissedIssues['https://github.com/owner/repo/pull/42']).toBeUndefined();
    expect(state.config.dismissedIssues['https://github.com/other/project/pull/99']).toBeUndefined();

    // Issue URLs should remain
    expect(state.config.dismissedIssues['https://github.com/owner/repo/issues/1']).toBe('2025-01-10T00:00:00Z');
    expect(state.config.dismissedIssues['https://github.com/other/project/issues/5']).toBe('2025-01-12T00:00:00Z');
  });

  it('preserves issue URLs in dismissedIssues', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const stateData = makeCurrentState();
    (stateData.config as Record<string, unknown>).dismissedIssues = {
      'https://github.com/owner/repo/issues/10': '2025-02-01T00:00:00Z',
      'https://github.com/owner/repo/issues/20': '2025-02-02T00:00:00Z',
      'https://github.com/owner/repo/pull/30': '2025-02-03T00:00:00Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(stateData), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // Both issue URLs survive intact
    expect(Object.keys(state.config.dismissedIssues)).toHaveLength(2);
    expect(state.config.dismissedIssues['https://github.com/owner/repo/issues/10']).toBe('2025-02-01T00:00:00Z');
    expect(state.config.dismissedIssues['https://github.com/owner/repo/issues/20']).toBe('2025-02-02T00:00:00Z');

    // Verify on disk as well
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(Object.keys(onDisk.config.dismissedIssues)).toHaveLength(2);
    expect(onDisk.config.dismissedIssues['https://github.com/owner/repo/pull/30']).toBeUndefined();
  });

  it('does not write to disk if no cleanup needed', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Write a clean v2 state — no snoozedPRs, no PR URLs in dismissedIssues
    const stateData = makeCurrentState();
    (stateData.config as Record<string, unknown>).dismissedIssues = {
      'https://github.com/owner/repo/issues/1': '2025-01-10T00:00:00Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(stateData), { mode: 0o600 });

    // Record file modification time before load
    const mtimeBefore = fs.statSync(statePath).mtimeMs;

    // Small delay so any write would be distinguishable by mtime
    const start = Date.now();
    while (Date.now() - start < 50) {
      // busy-wait to ensure mtime would differ if file were rewritten
    }

    const sm = new StateManager(false);
    const state = sm.getState();

    // State should load normally
    expect(state.config.dismissedIssues['https://github.com/owner/repo/issues/1']).toBe('2025-01-10T00:00:00Z');

    // File should NOT have been rewritten (mtime unchanged)
    const mtimeAfter = fs.statSync(statePath).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);
  });
});

describe('issueListPath in config', () => {
  it('should store and retrieve issueListPath via updateConfig', () => {
    const sm = new StateManager(true);
    sm.updateConfig({ issueListPath: '/path/to/issues.md' });
    expect(sm.getState().config.issueListPath).toBe('/path/to/issues.md');
  });

  it('should clear issueListPath by setting to undefined', () => {
    const sm = new StateManager(true);
    sm.updateConfig({ issueListPath: '/path/to/issues.md' });
    sm.updateConfig({ issueListPath: undefined });
    expect(sm.getState().config.issueListPath).toBeUndefined();
  });
});

// ── migrateFromLegacyLocation ───────────────────────────────────────────────
// Legacy paths resolve to packages/core/data/ during vitest (process.cwd()).
// Tests must create/cleanup this directory.
// ─────────────────────────────────────────────────────────────────────────────

describe('migrateFromLegacyLocation', () => {
  const legacyDataDir = path.join(process.cwd(), 'data');
  const legacyStatePath = path.join(legacyDataDir, 'state.json');
  const legacyBackupDir = path.join(legacyDataDir, 'backups');

  function createLegacyState(data: Record<string, unknown>): void {
    fs.mkdirSync(legacyDataDir, { recursive: true });
    fs.writeFileSync(legacyStatePath, JSON.stringify(data), { mode: 0o600 });
  }

  function createLegacyBackup(name: string, data: Record<string, unknown>): void {
    fs.mkdirSync(legacyBackupDir, { recursive: true });
    fs.writeFileSync(path.join(legacyBackupDir, name), JSON.stringify(data), { mode: 0o600 });
  }

  function cleanupLegacyDir(): void {
    fs.rmSync(legacyDataDir, { recursive: true, force: true });
  }

  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-legacy-'));
    cleanupLegacyDir(); // ensure clean slate
  });

  afterEach(() => {
    cleanupLegacyDir();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should migrate state from legacy ./data/ to new location', () => {
    createLegacyState(makeCurrentState({ config: { ...makeBaseConfig(), githubUsername: 'legacy-user' } }));

    const sm = new StateManager(false);
    expect(sm.getState().config.githubUsername).toBe('legacy-user');

    expect(fs.existsSync(path.join(mockTmpDir, 'state.json'))).toBe(true);
    expect(fs.existsSync(legacyStatePath)).toBe(false);
    expect(fs.existsSync(legacyDataDir)).toBe(false);
  });

  it('should migrate backup files from legacy location', () => {
    createLegacyState(makeCurrentState());
    createLegacyBackup('state-2024-01-01T00-00-00-000Z-abc123.json', makeCurrentState());
    createLegacyBackup('state-2024-01-02T00-00-00-000Z-def456.json', makeCurrentState());

    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(4);

    // Backups should be in the new location
    const newBackupDir = path.join(mockTmpDir, 'backups');
    const backups = fs.readdirSync(newBackupDir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
    expect(backups).toContain('state-2024-01-01T00-00-00-000Z-abc123.json');
    expect(backups).toContain('state-2024-01-02T00-00-00-000Z-def456.json');

    // Legacy backup dir should be removed
    expect(fs.existsSync(legacyBackupDir)).toBe(false);
  });

  it('should not remove legacy data dir if other files remain', () => {
    createLegacyState(makeCurrentState());
    fs.writeFileSync(path.join(legacyDataDir, 'other.txt'), 'keep me');

    new StateManager(false);

    expect(fs.existsSync(legacyStatePath)).toBe(false);
    expect(fs.existsSync(legacyDataDir)).toBe(true);
    expect(fs.existsSync(path.join(legacyDataDir, 'other.txt'))).toBe(true);
  });

  it('should skip migration when new state already exists', () => {
    const newStatePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(
      newStatePath,
      JSON.stringify(makeCurrentState({ config: { ...makeBaseConfig(), githubUsername: 'new-user' } })),
      { mode: 0o600 },
    );
    createLegacyState(makeCurrentState({ config: { ...makeBaseConfig(), githubUsername: 'legacy-user' } }));

    const sm = new StateManager(false);

    expect(sm.getState().config.githubUsername).toBe('new-user');
    expect(fs.existsSync(legacyStatePath)).toBe(true);
  });

  it('should handle migration failure gracefully', () => {
    createLegacyState(makeCurrentState());
    fs.chmodSync(legacyStatePath, 0o000);

    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(4);

    // Restore permissions so afterEach cleanup works
    fs.chmodSync(legacyStatePath, 0o600);
    expect(fs.existsSync(legacyStatePath)).toBe(true);
  });
});

// ── migrateV1ToV2 fallback branches ─────────────────────────────────────────
describe('migrateV1ToV2 fallback branches', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-v1-fallback-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should default undefined repoScores and activeIssues to empty values', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const v1 = makeV1State();
    delete v1.repoScores;
    delete v1.activeIssues;
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(4);
    expect(sm.getState().repoScores).toEqual({});
    expect(sm.getState().activeIssues).toEqual([]);
  });

  it('should seed repo scores from mergedPRs and closedPRs when repoScores is missing', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    const mergedPR = makeLegacyPR({
      id: 1,
      url: 'https://github.com/org-a/repo-a/pull/1',
      repo: 'org-a/repo-a',
      title: 'Merged',
      status: 'merged',
    });
    const closedPR = makeLegacyPR({
      id: 2,
      url: 'https://github.com/org-b/repo-b/pull/2',
      repo: 'org-b/repo-b',
      number: 2,
      title: 'Closed',
      status: 'closed',
    });
    const v1 = makeV1State({ mergedPRs: [mergedPR], closedPRs: [closedPR] });
    delete v1.repoScores;
    fs.writeFileSync(statePath, JSON.stringify(v1), { mode: 0o600 });

    const sm = new StateManager(false);
    expect(sm.getState().version).toBe(4);
    expect(sm.getState().repoScores['org-a/repo-a']).toBeDefined();
    expect(sm.getState().repoScores['org-b/repo-b']).toBeDefined();
    expect(sm.getState().repoScores['org-a/repo-a'].score).toBe(5);
  });
});

// ── Schema validation in loadState ──────────────────────────────────────────
// These tests verify that the Zod-based schema validation in the persistence
// layer (loadState / tryRestoreFromBackup) correctly rejects invalid state
// structures and fills defaults for missing optional fields.
// ─────────────────────────────────────────────────────────────────────────────
describe('schema validation in loadState', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-schema-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should return fresh state when state is schema-invalid and no backups exist', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Valid JSON but schema-invalid: config must be an object, not null
    fs.writeFileSync(statePath, JSON.stringify({ version: 4, config: null }), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(4);
    // Fresh state has empty default config values
    expect(state.config.githubUsername).toBe('');
    expect(state.config.setupComplete).toBe(false);
    expect(state.repoScores).toEqual({});
    expect(state.activeIssues).toEqual([]);
  });

  it('should skip schema-invalid backups and use the next valid one', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Corrupted main state file (unparseable JSON)
    fs.writeFileSync(statePath, 'CORRUPT MAIN', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Newest backup: valid JSON but schema-invalid (config is null)
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-03-01T00-00-00-000Z-zzz000.json'),
      JSON.stringify({ version: 4, config: null }),
      { mode: 0o600 },
    );

    // Middle backup: also schema-invalid (version is 99, not literal 2)
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-02-01T00-00-00-000Z-mmm000.json'),
      JSON.stringify({ version: 99, config: { githubUsername: 'bad-version' } }),
      { mode: 0o600 },
    );

    // Oldest backup: valid
    const validBackup = makeCurrentState();
    (validBackup.config as Record<string, unknown>)['githubUsername'] = 'valid-old-backup';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-aaa000.json'), JSON.stringify(validBackup), {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    // Should have skipped the two schema-invalid backups and restored from the valid one
    expect(sm.getState().config.githubUsername).toBe('valid-old-backup');
  });

  it('should return fresh state when all backups are schema-invalid', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Multiple backups, all valid JSON but schema-invalid
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-03-01T00-00-00-000Z-aaa000.json'),
      JSON.stringify({ version: 4, config: null }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-02-01T00-00-00-000Z-bbb000.json'),
      JSON.stringify({ version: 99, repoScores: 'not-an-object' }),
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-ccc000.json'),
      JSON.stringify({ version: 4, activeIssues: 'not-an-array' }),
      { mode: 0o600 },
    );

    const sm = new StateManager(false);
    const state = sm.getState();
    // All backups rejected by schema validation, so fresh state returned
    expect(state.version).toBe(4);
    expect(state.config.githubUsername).toBe('');
    expect(state.repoScores).toEqual({});
  });

  it('should fill defaults for missing optional fields via Zod on load', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Write a minimal valid v2 state missing optional fields that have defaults
    const minimalState = {
      version: 4,
      // config is missing — Zod default will fill it
      // repoScores is missing — Zod default will fill it to {}
      // lastRunAt is missing — Zod default will fill it
      // activeIssues is missing — Zod default will fill it to []
    };
    fs.writeFileSync(statePath, JSON.stringify(minimalState), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // Verify Zod defaults are applied at the top level
    expect(state.version).toBe(4);
    expect(state.repoScores).toEqual({});
    expect(state.activeIssues).toEqual([]);
    expect(typeof state.lastRunAt).toBe('string');
    expect(state.lastRunAt.length).toBeGreaterThan(0);

    // Spot-check config defaults (exhaustive default coverage in state-schema.test.ts)
    expect(state.config.setupComplete).toBe(false);
    expect(state.config.maxActivePRs).toBe(10);
    expect(state.config.githubUsername).toBe('');
  });

  it('should preserve existing fields while filling missing defaults on load', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // State with some fields present and some missing
    const partialState = {
      version: 4,
      repoScores: {
        'owner/repo': {
          repo: 'owner/repo',
          score: 8,
          mergedPRCount: 3,
          closedWithoutMergeCount: 0,
          avgResponseDays: 2.5,
          lastEvaluatedAt: '2024-06-01T00:00:00Z',
          signals: {
            hasActiveMaintainers: true,
            isResponsive: true,
            hasHostileComments: false,
          },
        },
      },
      config: {
        githubUsername: 'existing-user',
        setupComplete: true,
        // Other config fields missing — will be filled by Zod defaults
      },
      // activeIssues, lastRunAt all missing — Zod fills defaults
    };
    fs.writeFileSync(statePath, JSON.stringify(partialState), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();

    // Existing fields preserved
    expect(state.config.githubUsername).toBe('existing-user');
    expect(state.config.setupComplete).toBe(true);
    expect(state.repoScores['owner/repo'].score).toBe(8);
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(3);

    // Missing fields filled with defaults
    expect(state.activeIssues).toEqual([]);
    expect(typeof state.lastRunAt).toBe('string');
    expect(state.config.maxActivePRs).toBe(10);
    expect(state.config.languages).toEqual(['typescript', 'javascript']);
    expect(state.config.excludeRepos).toEqual([]);
  });
});

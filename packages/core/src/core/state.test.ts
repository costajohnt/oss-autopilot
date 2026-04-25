/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager, getStateManager, resetStateManager } from './state.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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

describe('StateManager', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    // Create a fresh in-memory state manager for each test
    stateManager = new StateManager(true);
  });

  describe('Issue Management', () => {
    it('should add an issue to active list', () => {
      const mockIssue = {
        id: 1,
        url: 'https://github.com/owner/repo/issues/1',
        repo: 'owner/repo',
        number: 1,
        title: 'Test issue',
        status: 'candidate' as const,
        labels: [],
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
        vetted: false,
      };
      stateManager.addIssue(mockIssue);
      const state = stateManager.getState();
      expect(state.activeIssues).toHaveLength(1);
    });
  });

  describe('Statistics', () => {
    it('should return 0% merge rate when no completed PRs', () => {
      const stats = stateManager.getStats();
      expect(stats.mergeRate).toBe('0.0%');
    });

    it('should return 0 for needsResponse in v2 (PRs fetched fresh from GitHub)', () => {
      // In v2, PRs are not tracked locally - they're fetched fresh
      // needsResponse is always 0 in getStats()
      const stats = stateManager.getStats();
      expect(stats.needsResponse).toBe(0);
    });
  });

  describe('Trusted Projects', () => {
    it('should add trusted project', () => {
      stateManager.addTrustedProject('owner/repo');
      const state = stateManager.getState();
      expect(state.config.trustedProjects).toContain('owner/repo');
    });

    it('should not add duplicate trusted projects', () => {
      stateManager.addTrustedProject('owner/repo');
      stateManager.addTrustedProject('owner/repo');
      const state = stateManager.getState();
      expect(state.config.trustedProjects.filter((p) => p === 'owner/repo')).toHaveLength(1);
    });
  });

  describe('Configuration', () => {
    it('should update config', () => {
      stateManager.updateConfig({ githubUsername: 'testuser' });
      const state = stateManager.getState();
      expect(state.config.githubUsername).toBe('testuser');
    });

    it('should merge config without overwriting other values', () => {
      stateManager.updateConfig({ githubUsername: 'testuser' });
      stateManager.updateConfig({ languages: ['rust'] });
      const state = stateManager.getState();
      expect(state.config.githubUsername).toBe('testuser');
      expect(state.config.languages).toContain('rust');
    });

    it('should add to excludeRepos', () => {
      stateManager.updateConfig({ excludeRepos: ['owner/repo'] });
      const state = stateManager.getState();
      expect(state.config.excludeRepos).toContain('owner/repo');
    });

    it('should store and retrieve skippedIssuesPath', () => {
      const sm = new StateManager(true);
      sm.updateConfig({ skippedIssuesPath: '/path/to/skipped-issues.md' });
      expect(sm.getState().config.skippedIssuesPath).toBe('/path/to/skipped-issues.md');
    });
  });

  describe('Edge Cases', () => {
    it('should isolate state between instances', () => {
      const sm1 = new StateManager(true);
      const sm2 = new StateManager(true);
      sm1.updateRepoScore('owner/repo', { mergedPRCount: 1 });
      expect(Object.keys(sm1.getState().repoScores)).toHaveLength(1);
      expect(Object.keys(sm2.getState().repoScores)).toHaveLength(0);
    });
  });
});

// Event logging tests removed — events field dropped in v3 schema

// ── Shelve / Unshelve ──────────────────────────────────────
describe('shelvePR / unshelvePR / isPRShelved', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should shelve a PR and mark it as shelved', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.shelvePR(url)).toBe(true);
    expect(stateManager.isPRShelved(url)).toBe(true);
  });

  it('should return false when shelving an already-shelved PR (idempotent)', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.shelvePR(url);
    expect(stateManager.shelvePR(url)).toBe(false);
  });

  it('should unshelve a shelved PR', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.shelvePR(url);
    expect(stateManager.unshelvePR(url)).toBe(true);
    expect(stateManager.isPRShelved(url)).toBe(false);
  });

  it('should return false when unshelving a PR that is not shelved', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.unshelvePR(url)).toBe(false);
  });

  it('should handle multiple shelved PRs independently', () => {
    const url1 = 'https://github.com/owner/repo/pull/1';
    const url2 = 'https://github.com/owner/repo/pull/2';
    stateManager.shelvePR(url1);
    stateManager.shelvePR(url2);
    expect(stateManager.isPRShelved(url1)).toBe(true);
    expect(stateManager.isPRShelved(url2)).toBe(true);

    stateManager.unshelvePR(url1);
    expect(stateManager.isPRShelved(url1)).toBe(false);
    expect(stateManager.isPRShelved(url2)).toBe(true);
  });

  it('should handle isPRShelved when shelvedPRUrls is undefined', () => {
    // Simulate legacy state without shelvedPRUrls
    (stateManager.getState().config as any).shelvedPRUrls = undefined;
    expect(stateManager.isPRShelved('https://github.com/owner/repo/pull/1')).toBe(false);
  });

  it('should initialize shelvedPRUrls array when first shelving', () => {
    (stateManager.getState().config as any).shelvedPRUrls = undefined;
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.shelvePR(url)).toBe(true);
    expect(stateManager.getState().config.shelvedPRUrls).toEqual([url]);
  });
});

// ── Dismiss / Undismiss Issues ──────────────────────────────────────
describe('dismissIssue / undismissIssue / getIssueDismissedAt', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should dismiss an issue and store the timestamp', () => {
    const url = 'https://github.com/owner/repo/issues/1';
    const timestamp = '2025-01-15T10:00:00.000Z';
    expect(stateManager.dismissIssue(url, timestamp)).toBe(true);
    expect(stateManager.getIssueDismissedAt(url)).toBe(timestamp);
  });

  it('should return false when dismissing an already-dismissed issue (idempotent)', () => {
    const url = 'https://github.com/owner/repo/issues/1';
    stateManager.dismissIssue(url, '2025-01-15T10:00:00.000Z');
    expect(stateManager.dismissIssue(url, '2025-01-16T10:00:00.000Z')).toBe(false);
    // Original timestamp is preserved
    expect(stateManager.getIssueDismissedAt(url)).toBe('2025-01-15T10:00:00.000Z');
  });

  it('should undismiss a dismissed issue', () => {
    const url = 'https://github.com/owner/repo/issues/1';
    stateManager.dismissIssue(url, '2025-01-15T10:00:00.000Z');
    expect(stateManager.undismissIssue(url)).toBe(true);
    expect(stateManager.getIssueDismissedAt(url)).toBeUndefined();
  });

  it('should return false when undismissing an issue that is not dismissed', () => {
    const url = 'https://github.com/owner/repo/issues/1';
    expect(stateManager.undismissIssue(url)).toBe(false);
  });

  it('should handle multiple dismissed issues independently', () => {
    const url1 = 'https://github.com/owner/repo/issues/1';
    const url2 = 'https://github.com/owner/repo/issues/2';
    stateManager.dismissIssue(url1, '2025-01-15T10:00:00.000Z');
    stateManager.dismissIssue(url2, '2025-01-16T10:00:00.000Z');
    expect(stateManager.getIssueDismissedAt(url1)).toBe('2025-01-15T10:00:00.000Z');
    expect(stateManager.getIssueDismissedAt(url2)).toBe('2025-01-16T10:00:00.000Z');

    stateManager.undismissIssue(url1);
    expect(stateManager.getIssueDismissedAt(url1)).toBeUndefined();
    expect(stateManager.getIssueDismissedAt(url2)).toBe('2025-01-16T10:00:00.000Z');
  });

  it('should handle getIssueDismissedAt when dismissedIssues is undefined', () => {
    (stateManager.getState().config as any).dismissedIssues = undefined;
    expect(stateManager.getIssueDismissedAt('https://github.com/owner/repo/issues/1')).toBeUndefined();
  });

  it('should initialize dismissedIssues object when first dismissing', () => {
    (stateManager.getState().config as any).dismissedIssues = undefined;
    const url = 'https://github.com/owner/repo/issues/1';
    const timestamp = '2025-01-15T10:00:00.000Z';
    expect(stateManager.dismissIssue(url, timestamp)).toBe(true);
    expect(stateManager.getState().config.dismissedIssues).toEqual({ [url]: timestamp });
  });
});

// ── Status overrides (#575) ─────────────────────────────────────────────────
describe('setStatusOverride / clearStatusOverride / getStatusOverride', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should set and retrieve a status override', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'needs_addressing', '2026-01-10T00:00:00Z');
    const override = stateManager.getStatusOverride('https://github.com/o/r/pull/1');
    expect(override).toBeDefined();
    expect(override!.status).toBe('needs_addressing');
    expect(override!.lastActivityAt).toBe('2026-01-10T00:00:00Z');
  });

  it('should return undefined for non-existent override', () => {
    expect(stateManager.getStatusOverride('https://github.com/o/r/pull/99')).toBeUndefined();
  });

  it('should clear an existing override', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'needs_addressing', '2026-01-10T00:00:00Z');
    const cleared = stateManager.clearStatusOverride('https://github.com/o/r/pull/1');
    expect(cleared).toBe(true);
    expect(stateManager.getStatusOverride('https://github.com/o/r/pull/1')).toBeUndefined();
  });

  it('should return false when clearing non-existent override', () => {
    expect(stateManager.clearStatusOverride('https://github.com/o/r/pull/99')).toBe(false);
  });

  it('should auto-clear override when PR has new activity', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'needs_addressing', '2026-01-10T00:00:00Z');
    // PR was updated after the override was set
    const override = stateManager.getStatusOverride('https://github.com/o/r/pull/1', '2026-01-11T00:00:00Z');
    expect(override).toBeUndefined();
    // Override should be removed from state
    expect(stateManager.getStatusOverride('https://github.com/o/r/pull/1')).toBeUndefined();
  });

  it('should keep override when PR has no new activity', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'needs_addressing', '2026-01-10T00:00:00Z');
    // PR updatedAt is same as when override was set
    const override = stateManager.getStatusOverride('https://github.com/o/r/pull/1', '2026-01-10T00:00:00Z');
    expect(override).toBeDefined();
    expect(override!.status).toBe('needs_addressing');
  });

  it('should keep override when no currentUpdatedAt is provided', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'waiting_on_maintainer', '2026-01-10T00:00:00Z');
    const override = stateManager.getStatusOverride('https://github.com/o/r/pull/1');
    expect(override).toBeDefined();
    expect(override!.status).toBe('waiting_on_maintainer');
  });

  it('should overwrite an existing override', () => {
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'needs_addressing', '2026-01-10T00:00:00Z');
    stateManager.setStatusOverride('https://github.com/o/r/pull/1', 'waiting_on_maintainer', '2026-01-12T00:00:00Z');
    const override = stateManager.getStatusOverride('https://github.com/o/r/pull/1');
    expect(override!.status).toBe('waiting_on_maintainer');
    expect(override!.lastActivityAt).toBe('2026-01-12T00:00:00Z');
  });
});

// ── getStats() exclusion filtering (#211) ──────────────────────────────────
describe('StateManager getStats exclusion filtering', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should include repos in excludeRepos in merged/closed totals (#591)', () => {
    stateManager.updateRepoScore('owner/included', {
      mergedPRCount: 3,
      closedWithoutMergeCount: 1,
      stargazersCount: 100,
    });
    stateManager.updateRepoScore('owner/excluded', {
      mergedPRCount: 10,
      closedWithoutMergeCount: 5,
      stargazersCount: 100,
    });
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    // excludeRepos only affects issue discovery, not stats
    expect(stats.mergedPRs).toBe(13);
    expect(stats.closedPRs).toBe(6);
    expect(stats.totalTracked).toBe(2);
  });

  it('should include repos from excludeOrgs in stats (#591)', () => {
    stateManager.updateRepoScore('bad-org/repo-a', { mergedPRCount: 5, stargazersCount: 100 });
    stateManager.updateRepoScore('bad-org/repo-b', { mergedPRCount: 3, stargazersCount: 100 });
    stateManager.updateRepoScore('good-org/repo-c', { mergedPRCount: 2, stargazersCount: 100 });
    stateManager.updateConfig({ excludeOrgs: ['bad-org'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(10);
    expect(stats.totalTracked).toBe(3);
  });

  it('should work when excludeOrgs is undefined', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2, stargazersCount: 100 });
    // excludeOrgs is not set (undefined) — should not crash
    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(2);
    expect(stats.totalTracked).toBe(1);
  });

  it('should not filter trustedProjects count by excludeRepos (#591)', () => {
    stateManager.addTrustedProject('owner/kept');
    stateManager.addTrustedProject('owner/excluded');
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    expect(stats.trustedProjects).toBe(2);
  });

  it('should not filter trustedProjects count by excludeOrgs (#591)', () => {
    stateManager.addTrustedProject('bad-org/repo-a');
    stateManager.addTrustedProject('bad-org/repo-b');
    stateManager.addTrustedProject('good-org/repo-c');
    stateManager.updateConfig({ excludeOrgs: ['bad-org'] });

    const stats = stateManager.getStats();
    expect(stats.trustedProjects).toBe(3);
  });

  it('should include excluded repos in mergeRate computation (#591)', () => {
    stateManager.updateRepoScore('owner/included', {
      mergedPRCount: 1,
      closedWithoutMergeCount: 1,
      stargazersCount: 100,
    });
    stateManager.updateRepoScore('owner/excluded', {
      mergedPRCount: 100,
      closedWithoutMergeCount: 0,
      stargazersCount: 100,
    });
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    // All repos included: 101 merged / 102 total = 99.0%
    expect(stats.mergeRate).toBe('99.0%');
  });

  it('should exclude repos with fewer than 50 stars or unknown star count', () => {
    stateManager.updateRepoScore('owner/big-repo', { mergedPRCount: 5, stargazersCount: 100 });
    stateManager.updateRepoScore('owner/small-repo', { mergedPRCount: 3, stargazersCount: 10 });
    stateManager.updateRepoScore('owner/no-stars', { mergedPRCount: 2 }); // stargazersCount undefined — excluded

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(5); // only big-repo; small-repo (10 stars) and no-stars (undefined) excluded
    expect(stats.totalTracked).toBe(1);
  });

  it('should include repos with exactly 50 stars', () => {
    stateManager.updateRepoScore('owner/boundary-repo', { mergedPRCount: 4, stargazersCount: 50 });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(4);
    expect(stats.totalTracked).toBe(1);
  });

  it('should return all repos when no exclusions are set', () => {
    stateManager.updateRepoScore('a/b', { mergedPRCount: 2, stargazersCount: 100 });
    stateManager.updateRepoScore('c/d', { mergedPRCount: 1, stargazersCount: 100 });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(3);
    expect(stats.totalTracked).toBe(2);
  });

  it('should store stargazersCount via updateRepoScore (#216)', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, stargazersCount: 500 });
    const score = stateManager.getRepoScore('owner/repo');
    expect(score?.stargazersCount).toBe(500);
  });

  it('should update stargazersCount without affecting other fields (#216)', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 3, closedWithoutMergeCount: 1 });
    stateManager.updateRepoScore('owner/repo', { stargazersCount: 1000 });
    const score = stateManager.getRepoScore('owner/repo');
    expect(score?.stargazersCount).toBe(1000);
    expect(score?.mergedPRCount).toBe(3);
    expect(score?.closedWithoutMergeCount).toBe(1);
  });

  it('should store language via updateRepoScore (#677)', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, language: 'TypeScript' });
    const score = stateManager.getRepoScore('owner/repo');
    expect(score?.language).toBe('TypeScript');
  });

  it('should store null language (repo with no detected language) (#677)', () => {
    stateManager.updateRepoScore('owner/repo', { language: null });
    const score = stateManager.getRepoScore('owner/repo');
    expect(score?.language).toBeNull();
  });

  it('should not clobber language when updating other fields (#677)', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2, language: 'Rust' });
    stateManager.updateRepoScore('owner/repo', { stargazersCount: 500 });
    const score = stateManager.getRepoScore('owner/repo');
    expect(score?.language).toBe('Rust');
    expect(score?.stargazersCount).toBe(500);
    expect(score?.mergedPRCount).toBe(2);
  });
});

// ── cleanupExcludedData (#591) ──────────────────────────────────────────────
describe('StateManager cleanupExcludedData', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should remove matching repo from trustedProjects', () => {
    stateManager.addTrustedProject('owner/repo-a');
    stateManager.addTrustedProject('owner/repo-b');
    stateManager.cleanupExcludedData(['owner/repo-a'], []);

    expect(stateManager.getState().config.trustedProjects).toEqual(['owner/repo-b']);
  });

  it('should preserve repoScores for excluded repos (#591)', () => {
    stateManager.updateRepoScore('owner/repo-a', { mergedPRCount: 1 });
    stateManager.updateRepoScore('owner/repo-b', { mergedPRCount: 2 });
    stateManager.cleanupExcludedData(['owner/repo-a'], []);

    expect(stateManager.getState().repoScores['owner/repo-a']).toBeDefined();
    expect(stateManager.getState().repoScores['owner/repo-b']).toBeDefined();
  });

  it('should remove org repos from trustedProjects but preserve repoScores (#591)', () => {
    stateManager.addTrustedProject('bad-org/repo-a');
    stateManager.addTrustedProject('bad-org/repo-b');
    stateManager.addTrustedProject('good-org/repo-c');
    stateManager.updateRepoScore('bad-org/repo-a', { mergedPRCount: 1 });
    stateManager.updateRepoScore('bad-org/repo-b', { mergedPRCount: 2 });
    stateManager.updateRepoScore('good-org/repo-c', { mergedPRCount: 3 });

    stateManager.cleanupExcludedData([], ['bad-org']);

    expect(stateManager.getState().config.trustedProjects).toEqual(['good-org/repo-c']);
    expect(stateManager.getState().repoScores['bad-org/repo-a']).toBeDefined();
    expect(stateManager.getState().repoScores['bad-org/repo-b']).toBeDefined();
    expect(stateManager.getState().repoScores['good-org/repo-c']).toBeDefined();
  });

  it('should match repo name case-insensitively', () => {
    stateManager.addTrustedProject('facebook/react');
    stateManager.updateRepoScore('facebook/react', { mergedPRCount: 1 });

    stateManager.cleanupExcludedData(['Facebook/React'], []);

    expect(stateManager.getState().config.trustedProjects).toEqual([]);
    expect(stateManager.getState().repoScores['facebook/react']).toBeDefined();
  });

  it('should match org name case-insensitively', () => {
    stateManager.addTrustedProject('MyOrg/repo');
    stateManager.updateRepoScore('MyOrg/repo', { mergedPRCount: 1 });

    stateManager.cleanupExcludedData([], ['myorg']);

    expect(stateManager.getState().config.trustedProjects).toEqual([]);
    expect(stateManager.getState().repoScores['MyOrg/repo']).toBeDefined();
  });

  it('should be a no-op when no repos match', () => {
    stateManager.addTrustedProject('owner/repo');
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1 });

    stateManager.cleanupExcludedData(['other/repo'], ['other-org']);

    expect(stateManager.getState().config.trustedProjects).toEqual(['owner/repo']);
    expect(stateManager.getState().repoScores['owner/repo']).toBeDefined();
  });

  it('should handle empty repos and orgs arrays', () => {
    stateManager.addTrustedProject('owner/repo');
    stateManager.cleanupExcludedData([], []);
    expect(stateManager.getState().config.trustedProjects).toEqual(['owner/repo']);
  });

  it('should handle both repos and orgs simultaneously', () => {
    stateManager.addTrustedProject('org-a/repo-1');
    stateManager.addTrustedProject('org-b/repo-2');
    stateManager.addTrustedProject('org-c/repo-3');
    stateManager.updateRepoScore('org-a/repo-1', { mergedPRCount: 1 });
    stateManager.updateRepoScore('org-b/repo-2', { mergedPRCount: 2 });
    stateManager.updateRepoScore('org-c/repo-3', { mergedPRCount: 3 });

    stateManager.cleanupExcludedData(['org-b/repo-2'], ['org-a']);

    expect(stateManager.getState().config.trustedProjects).toEqual(['org-c/repo-3']);
    // repoScores preserved for all repos (#591)
    expect(Object.keys(stateManager.getState().repoScores).sort()).toEqual([
      'org-a/repo-1',
      'org-b/repo-2',
      'org-c/repo-3',
    ]);
  });
});

describe('getStateManager / resetStateManager singleton', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-'));
    resetStateManager();
  });

  afterEach(() => {
    resetStateManager();
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
  });

  it('should return a StateManager instance', () => {
    const sm = getStateManager();
    expect(sm).toBeInstanceOf(StateManager);
  });

  it('should return the same instance on subsequent calls', () => {
    const sm1 = getStateManager();
    const sm2 = getStateManager();
    expect(sm1).toBe(sm2);
  });

  it('should return a new instance after resetStateManager', () => {
    const sm1 = getStateManager();
    resetStateManager();
    const sm2 = getStateManager();
    expect(sm1).not.toBe(sm2);
  });
});

describe('StateManager initializeWithDefaults', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should set username and mark setup complete', () => {
    stateManager.initializeWithDefaults('testuser');
    const state = stateManager.getState();
    expect(state.config.githubUsername).toBe('testuser');
    expect(state.config.setupComplete).toBe(true);
    expect(state.config.setupCompletedAt).toBeDefined();
    // Verify it's a valid ISO timestamp
    expect(new Date(state.config.setupCompletedAt!).toISOString()).toBe(state.config.setupCompletedAt);
  });

  it('should NOT overwrite existing config if setup already complete', () => {
    // First initialization
    stateManager.initializeWithDefaults('firstuser');
    const firstTimestamp = stateManager.getState().config.setupCompletedAt;

    // Second initialization attempt — should be a no-op
    stateManager.initializeWithDefaults('seconduser');
    const state = stateManager.getState();
    expect(state.config.githubUsername).toBe('firstuser');
    expect(state.config.setupCompletedAt).toBe(firstTimestamp);
  });

  it('should use sensible defaults', () => {
    stateManager.initializeWithDefaults('testuser');
    const state = stateManager.getState();
    expect(state.config.maxActivePRs).toBe(10);
    expect(state.config.languages).toEqual(['typescript', 'javascript']);
    expect(state.config.labels).toEqual(['good first issue', 'help wanted']);
  });

  it('should call save()', () => {
    const saveSpy = vi.spyOn(stateManager, 'save');
    stateManager.initializeWithDefaults('testuser');
    expect(saveSpy).toHaveBeenCalledOnce();
    saveSpy.mockRestore();
  });
});

describe('StateManager merged PRs', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  describe('getMergedPRs', () => {
    it('returns empty array when no merged PRs stored', () => {
      expect(stateManager.getMergedPRs()).toEqual([]);
    });

    it('returns stored merged PRs', () => {
      const prs = [{ url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' }];
      stateManager.addMergedPRs(prs);
      expect(stateManager.getMergedPRs()).toEqual(prs);
    });
  });

  describe('addMergedPRs', () => {
    it('deduplicates by URL', () => {
      const pr1 = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };
      const pr1Dup = { url: 'https://github.com/a/b/pull/1', title: 'PR 1 updated', mergedAt: '2025-06-11T00:00:00Z' };
      const pr2 = { url: 'https://github.com/a/b/pull/2', title: 'PR 2', mergedAt: '2025-06-09T00:00:00Z' };

      stateManager.addMergedPRs([pr1]);
      stateManager.addMergedPRs([pr1Dup, pr2]);

      const result = stateManager.getMergedPRs();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.url)).toEqual(['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2']);
      // Original title preserved (not overwritten by duplicate)
      expect(result.find((p) => p.url === pr1.url)?.title).toBe('PR 1');
    });

    it('sorts by mergedAt descending (newest first)', () => {
      const prs = [
        { url: 'https://github.com/a/b/pull/1', title: 'Old', mergedAt: '2025-01-01T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/2', title: 'New', mergedAt: '2025-06-15T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/3', title: 'Mid', mergedAt: '2025-03-10T00:00:00Z' },
      ];

      stateManager.addMergedPRs(prs);

      const result = stateManager.getMergedPRs();
      expect(result.map((p) => p.title)).toEqual(['New', 'Mid', 'Old']);
    });

    it('does nothing when passed empty array', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };
      stateManager.addMergedPRs([pr]);
      const before = stateManager.getMergedPRs();

      stateManager.addMergedPRs([]);

      expect(stateManager.getMergedPRs()).toEqual(before);
    });

    it('does nothing when all PRs are duplicates', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };
      stateManager.addMergedPRs([pr]);

      const saveSpy = vi.spyOn(stateManager, 'save');
      stateManager.addMergedPRs([pr]);
      // save is not called because no new PRs were added (early return)
      expect(saveSpy).not.toHaveBeenCalled();
      saveSpy.mockRestore();
    });

    it('initializes mergedPRs array when undefined', () => {
      // Force undefined state
      (stateManager as any).state.mergedPRs = undefined;
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };

      stateManager.addMergedPRs([pr]);

      expect(stateManager.getMergedPRs()).toHaveLength(1);
    });

    it('drops entries with invalid URLs and reports the count (#1120)', () => {
      const valid = { url: 'https://github.com/a/b/pull/1', title: 'Valid', mergedAt: '2025-06-10T00:00:00Z' };
      const bogus = { url: 'not-a-real-url', title: 'Bogus', mergedAt: '2025-06-09T00:00:00Z' };
      const nonGithub = {
        url: 'https://example.com/foo/bar/pull/1',
        title: 'Non-GitHub',
        mergedAt: '2025-06-08T00:00:00Z',
      };

      const result = stateManager.addMergedPRs([valid, bogus, nonGithub]);

      expect(result).toEqual({ added: 1, dropped: 2 });
      expect(stateManager.getMergedPRs()).toEqual([valid]);
    });

    it('returns added/dropped counts on a normal add', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };
      expect(stateManager.addMergedPRs([pr])).toEqual({ added: 1, dropped: 0 });
    });

    it('returns zero counts on empty input', () => {
      expect(stateManager.addMergedPRs([])).toEqual({ added: 0, dropped: 0 });
    });

    it('returns zero added when all inputs are duplicates of stored entries', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', mergedAt: '2025-06-10T00:00:00Z' };
      stateManager.addMergedPRs([pr]);
      expect(stateManager.addMergedPRs([pr])).toEqual({ added: 0, dropped: 0 });
    });
  });

  describe('getMergedPRWatermark', () => {
    it('returns undefined when no merged PRs stored', () => {
      expect(stateManager.getMergedPRWatermark()).toBeUndefined();
    });

    it('returns most recent mergedAt (first element after sort)', () => {
      stateManager.addMergedPRs([
        { url: 'https://github.com/a/b/pull/1', title: 'Old', mergedAt: '2025-01-01T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/2', title: 'New', mergedAt: '2025-06-15T00:00:00Z' },
      ]);

      expect(stateManager.getMergedPRWatermark()).toBe('2025-06-15T00:00:00Z');
    });

    it('returns undefined when mergedPRs is undefined', () => {
      (stateManager as any).state.mergedPRs = undefined;
      expect(stateManager.getMergedPRWatermark()).toBeUndefined();
    });

    it('returns undefined when most recent mergedAt is empty string', () => {
      (stateManager as any).state.mergedPRs = [{ url: 'https://github.com/a/b/pull/1', title: 'Bad', mergedAt: '' }];
      expect(stateManager.getMergedPRWatermark()).toBeUndefined();
    });
  });

  describe('getClosedPRs', () => {
    it('returns empty array when no closed PRs stored', () => {
      expect(stateManager.getClosedPRs()).toEqual([]);
    });

    it('returns stored closed PRs', () => {
      const prs = [{ url: 'https://github.com/a/b/pull/1', title: 'PR 1', closedAt: '2025-06-10T00:00:00Z' }];
      stateManager.addClosedPRs(prs);
      expect(stateManager.getClosedPRs()).toEqual(prs);
    });
  });

  describe('addClosedPRs', () => {
    it('deduplicates by URL', () => {
      const pr1 = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', closedAt: '2025-06-10T00:00:00Z' };
      const pr1Dup = { url: 'https://github.com/a/b/pull/1', title: 'PR 1 updated', closedAt: '2025-06-11T00:00:00Z' };
      const pr2 = { url: 'https://github.com/a/b/pull/2', title: 'PR 2', closedAt: '2025-06-09T00:00:00Z' };

      stateManager.addClosedPRs([pr1]);
      stateManager.addClosedPRs([pr1Dup, pr2]);

      const result = stateManager.getClosedPRs();
      expect(result).toHaveLength(2);
      expect(result.map((p) => p.url)).toEqual(['https://github.com/a/b/pull/1', 'https://github.com/a/b/pull/2']);
      // Original title preserved (not overwritten by duplicate)
      expect(result.find((p) => p.url === pr1.url)?.title).toBe('PR 1');
    });

    it('sorts by closedAt descending (newest first)', () => {
      const prs = [
        { url: 'https://github.com/a/b/pull/1', title: 'Old', closedAt: '2025-01-01T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/2', title: 'New', closedAt: '2025-06-15T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/3', title: 'Mid', closedAt: '2025-03-10T00:00:00Z' },
      ];

      stateManager.addClosedPRs(prs);

      const result = stateManager.getClosedPRs();
      expect(result.map((p) => p.title)).toEqual(['New', 'Mid', 'Old']);
    });

    it('does nothing when passed empty array', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', closedAt: '2025-06-10T00:00:00Z' };
      stateManager.addClosedPRs([pr]);
      const before = stateManager.getClosedPRs();

      stateManager.addClosedPRs([]);

      expect(stateManager.getClosedPRs()).toEqual(before);
    });

    it('does nothing when all PRs are duplicates', () => {
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', closedAt: '2025-06-10T00:00:00Z' };
      stateManager.addClosedPRs([pr]);

      const saveSpy = vi.spyOn(stateManager, 'save');
      stateManager.addClosedPRs([pr]);
      // save is not called because no new PRs were added (early return)
      expect(saveSpy).not.toHaveBeenCalled();
      saveSpy.mockRestore();
    });

    it('initializes closedPRs array when undefined', () => {
      // Force undefined state
      (stateManager as any).state.closedPRs = undefined;
      const pr = { url: 'https://github.com/a/b/pull/1', title: 'PR 1', closedAt: '2025-06-10T00:00:00Z' };

      stateManager.addClosedPRs([pr]);

      expect(stateManager.getClosedPRs()).toHaveLength(1);
    });

    it('drops entries with invalid URLs and reports the count (#1120)', () => {
      const valid = { url: 'https://github.com/a/b/pull/1', title: 'Valid', closedAt: '2025-06-10T00:00:00Z' };
      const bogus = { url: 'garbage', title: 'Bogus', closedAt: '2025-06-09T00:00:00Z' };

      const result = stateManager.addClosedPRs([valid, bogus]);

      expect(result).toEqual({ added: 1, dropped: 1 });
      expect(stateManager.getClosedPRs()).toEqual([valid]);
    });
  });

  describe('getClosedPRWatermark', () => {
    it('returns undefined when no closed PRs stored', () => {
      expect(stateManager.getClosedPRWatermark()).toBeUndefined();
    });

    it('returns most recent closedAt (first element after sort)', () => {
      stateManager.addClosedPRs([
        { url: 'https://github.com/a/b/pull/1', title: 'Old', closedAt: '2025-01-01T00:00:00Z' },
        { url: 'https://github.com/a/b/pull/2', title: 'New', closedAt: '2025-06-15T00:00:00Z' },
      ]);

      expect(stateManager.getClosedPRWatermark()).toBe('2025-06-15T00:00:00Z');
    });

    it('returns undefined when closedPRs is undefined', () => {
      (stateManager as any).state.closedPRs = undefined;
      expect(stateManager.getClosedPRWatermark()).toBeUndefined();
    });

    it('returns undefined when most recent closedAt is empty string', () => {
      (stateManager as any).state.closedPRs = [{ url: 'https://github.com/a/b/pull/1', title: 'Bad', closedAt: '' }];
      expect(stateManager.getClosedPRWatermark()).toBeUndefined();
    });
  });
});

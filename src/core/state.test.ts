/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager, acquireLock, releaseLock, atomicWriteFileSync } from './state.js';
import { StateEventType } from './types.js';
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

vi.mock('./utils.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils.js')>();
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

describe('StateManager calculateScore (via updateRepoScore)', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should assign base score of 5 for a new repo', () => {
    stateManager.updateRepoScore('owner/repo', {});
    const score = stateManager.getRepoScore('owner/repo');
    expect(score).toBeDefined();
    expect(score!.score).toBe(5);
  });

  it('should apply logarithmic merge bonus (1 merge → +2)', () => {
    // log2(1+1)*2 = log2(2)*2 = 1*2 = 2, score = 5+2 = 7
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1 });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(7);
  });

  it('should apply logarithmic merge bonus (3 merges → +4)', () => {
    // log2(3+1)*2 = log2(4)*2 = 2*2 = 4, score = 5+4 = 9
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 3 });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(9);
  });

  it('should cap logarithmic merge bonus at +5 (5+ merges)', () => {
    // log2(5+1)*2 = log2(6)*2 = 2.585*2 = 5.17, rounded to 5, score = 5+5 = 10
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 5 });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(10);
  });

  it('should also cap at +5 for 7+ merges', () => {
    // log2(7+1)*2 = log2(8)*2 = 3*2 = 6, capped at 5, score = 5+5 = 10
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 7 });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(10);
  });

  it('should differentiate 2 merges from 7 merges', () => {
    stateManager.updateRepoScore('owner/few', { mergedPRCount: 2 });
    stateManager.updateRepoScore('owner/many', { mergedPRCount: 7 });
    const fewScore = stateManager.getRepoScore('owner/few')!.score;
    const manyScore = stateManager.getRepoScore('owner/many')!.score;
    expect(manyScore).toBeGreaterThan(fewScore);
  });

  it('should subtract -1 per closed without merge, capped at -3', () => {
    // 5 closed without merge => penalty would be 5, but capped at -3 => score = 2
    stateManager.updateRepoScore('owner/repo', { closedWithoutMergeCount: 5 });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(2);
  });

  it('should add +1 for recency (last merge within 90 days)', () => {
    const recentDate = new Date();
    recentDate.setDate(recentDate.getDate() - 30);
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, lastMergedAt: recentDate.toISOString() });
    // 5 + 2 (1 merge) + 1 (recency) = 8
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(8);
  });

  it('should add recency bonus at exactly 90 days', () => {
    const boundaryDate = new Date();
    boundaryDate.setDate(boundaryDate.getDate() - 90);
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, lastMergedAt: boundaryDate.toISOString() });
    // 5 + 2 (1 merge) + 1 (recency, daysSince <= 90) = 8
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(8);
  });

  it('should NOT add recency bonus for merges older than 90 days', () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 120);
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, lastMergedAt: oldDate.toISOString() });
    // 5 + 2 (1 merge) + 0 (no recency) = 7
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(7);
  });

  it('should skip recency bonus for invalid lastMergedAt date', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1, lastMergedAt: 'invalid-date' });
    // 5 + 2 (1 merge) + 0 (invalid date, no recency) = 7
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(7);
  });

  it('should add +1 for responsive signal', () => {
    stateManager.updateRepoScore('owner/repo', {
      signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false },
    });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(6);
  });

  it('should subtract -2 for hostile signal', () => {
    stateManager.updateRepoScore('owner/repo', {
      signals: { hasHostileComments: true, hasActiveMaintainers: true, isResponsive: false },
    });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(3);
  });

  it('should clamp score to minimum of 1', () => {
    // Base 5, -3 (closed penalty max), -2 (hostile) = 0 => clamped to 1
    stateManager.updateRepoScore('owner/repo', {
      closedWithoutMergeCount: 10,
      signals: { hasHostileComments: true, hasActiveMaintainers: true, isResponsive: false },
    });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(1);
  });

  it('should clamp score to maximum of 10', () => {
    // Base 5, +5 (merged cap), +1 (responsive) = 11 => clamped to 10
    stateManager.updateRepoScore('owner/repo', {
      mergedPRCount: 100,
      signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false },
    });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(10);
  });
});

describe('StateManager updateRepoScore partial signals', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should preserve hasHostileComments when updating with partial signals', () => {
    // First set hostile to true
    stateManager.updateRepoScore('owner/repo', {
      signals: { hasHostileComments: true, hasActiveMaintainers: true, isResponsive: false },
    });
    expect(stateManager.getRepoScore('owner/repo')!.signals.hasHostileComments).toBe(true);

    // Now update only isResponsive — hasHostileComments should be preserved
    stateManager.updateRepoScore('owner/repo', {
      signals: { isResponsive: true, hasActiveMaintainers: true },
    });
    const score = stateManager.getRepoScore('owner/repo')!;
    expect(score.signals.hasHostileComments).toBe(true);
    expect(score.signals.isResponsive).toBe(true);
  });

  it('should preserve isResponsive when updating only hasHostileComments', () => {
    stateManager.updateRepoScore('owner/repo', {
      signals: { isResponsive: true, hasActiveMaintainers: false, hasHostileComments: false },
    });

    stateManager.updateRepoScore('owner/repo', {
      signals: { hasHostileComments: true },
    });
    const score = stateManager.getRepoScore('owner/repo')!;
    expect(score.signals.isResponsive).toBe(true);
    expect(score.signals.hasHostileComments).toBe(true);
  });
});

describe('StateManager getReposWithMergedPRs', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should return empty array when no repos have merged PRs', () => {
    expect(stateManager.getReposWithMergedPRs()).toEqual([]);
  });

  it('should return repos with mergedPRCount > 0', () => {
    stateManager.updateRepoScore('owner/merged-repo', { mergedPRCount: 2 });
    stateManager.updateRepoScore('owner/no-merges', { mergedPRCount: 0 });
    stateManager.updateRepoScore('owner/also-merged', { mergedPRCount: 1 });

    const repos = stateManager.getReposWithMergedPRs();
    expect(repos).toHaveLength(2);
    expect(repos).toContain('owner/merged-repo');
    expect(repos).toContain('owner/also-merged');
    expect(repos).not.toContain('owner/no-merges');
  });

  it('should sort by merged count descending', () => {
    stateManager.updateRepoScore('owner/few', { mergedPRCount: 1 });
    stateManager.updateRepoScore('owner/many', { mergedPRCount: 5 });
    stateManager.updateRepoScore('owner/some', { mergedPRCount: 3 });

    const repos = stateManager.getReposWithMergedPRs();
    expect(repos).toEqual(['owner/many', 'owner/some', 'owner/few']);
  });

  it('should not include repos that only have closed PRs', () => {
    stateManager.updateRepoScore('owner/rejected', { closedWithoutMergeCount: 3, mergedPRCount: 0 });
    stateManager.updateRepoScore('owner/merged', { mergedPRCount: 1 });

    const repos = stateManager.getReposWithMergedPRs();
    expect(repos).toEqual(['owner/merged']);
  });
});

describe('StateManager getReposWithOpenPRs', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should return empty array when no repos have score data', () => {
    expect(stateManager.getReposWithOpenPRs()).toEqual([]);
  });

  it('should return repos with mergedPRCount === 0 and no rejections (interacted but no merges)', () => {
    stateManager.updateRepoScore('owner/rejected', { mergedPRCount: 0, closedWithoutMergeCount: 1 });
    stateManager.updateRepoScore('owner/merged-repo', { mergedPRCount: 2 });
    stateManager.updateRepoScore('owner/open-only', { mergedPRCount: 0 });

    const repos = stateManager.getReposWithOpenPRs();
    expect(repos).toHaveLength(1);
    expect(repos).toContain('owner/open-only');
    expect(repos).not.toContain('owner/rejected');
    expect(repos).not.toContain('owner/merged-repo');
  });

  it('should sort by score descending', () => {
    // Both have no merges and no rejections — differentiate by signals
    stateManager.updateRepoScore('owner/low-score', {
      mergedPRCount: 0,
      // default score (5) with no signals
    });
    stateManager.updateRepoScore('owner/high-score', {
      mergedPRCount: 0,
      signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false },
    });

    const repos = stateManager.getReposWithOpenPRs();
    expect(repos[0]).toBe('owner/high-score');
    expect(repos[1]).toBe('owner/low-score');
  });

  it('should NOT include repos with merged PRs', () => {
    stateManager.updateRepoScore('owner/merged', { mergedPRCount: 1 });
    stateManager.updateRepoScore('owner/open', { mergedPRCount: 0 });

    const repos = stateManager.getReposWithOpenPRs();
    expect(repos).toEqual(['owner/open']);
  });
});

describe('StateManager state validity', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should have required v2 structure on initialization', () => {
    const state = stateManager.getState();
    expect(state.version).toBe(2);
    expect(state.config).toBeDefined();
    expect(typeof state.config).toBe('object');
    expect(state.repoScores).toBeDefined();
    expect(typeof state.repoScores).toBe('object');
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.events).toHaveLength(0);
    expect(Array.isArray(state.activeIssues)).toBe(true);
    expect(typeof state.lastRunAt).toBe('string');
  });

  it('should maintain valid structure after operations', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2 });
    stateManager.appendEvent('daily_check', { note: 'test' });

    const state = stateManager.getState();
    expect(state.version).toBe(2);
    expect(typeof state.config).toBe('object');
    expect(typeof state.repoScores).toBe('object');
    expect(Array.isArray(state.events)).toBe(true);
    expect(Object.keys(state.repoScores)).toHaveLength(1);
    expect(state.events.length).toBeGreaterThanOrEqual(1);
  });

  it('should aggregate stats correctly from repo scores', () => {
    stateManager.updateRepoScore('owner/repo-a', { mergedPRCount: 3, closedWithoutMergeCount: 1 });
    stateManager.updateRepoScore('owner/repo-b', { mergedPRCount: 2, closedWithoutMergeCount: 0 });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(5);
    expect(stats.closedPRs).toBe(1);
    expect(stats.totalTracked).toBe(2);
    // mergeRate = 5 / (5+1) * 100 = 83.3%
    expect(stats.mergeRate).toBe('83.3%');
  });
});

describe('StateManager markRepoHostile signal preservation', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should preserve isResponsive when marking repo as hostile', () => {
    stateManager.updateRepoScore('owner/repo', {
      signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false },
    });
    stateManager.markRepoHostile('owner/repo');
    const score = stateManager.getRepoScore('owner/repo')!;
    expect(score.signals.hasHostileComments).toBe(true);
    expect(score.signals.isResponsive).toBe(true);
    expect(score.signals.hasActiveMaintainers).toBe(true);
  });

  it('should apply -2 hostile penalty to score', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 1 });
    const scoreBefore = stateManager.getRepoScore('owner/repo')!.score;
    stateManager.markRepoHostile('owner/repo');
    const scoreAfter = stateManager.getRepoScore('owner/repo')!.score;
    expect(scoreAfter).toBe(scoreBefore - 2);
  });

  it('should create default score record if repo not yet scored', () => {
    stateManager.markRepoHostile('owner/new-repo');
    const score = stateManager.getRepoScore('owner/new-repo')!;
    expect(score).toBeDefined();
    expect(score.signals.hasHostileComments).toBe(true);
    // Base 5 - 2 hostile = 3
    expect(score.score).toBe(3);
  });
});

describe('StateManager incrementMergedCount / incrementClosedCount routing', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should create record and set count to 1 for new repo', () => {
    stateManager.incrementMergedCount('owner/new-repo');
    const score = stateManager.getRepoScore('owner/new-repo')!;
    expect(score).toBeDefined();
    expect(score.mergedPRCount).toBe(1);
    expect(score.lastMergedAt).toBeDefined();
  });

  it('should increment correctly on multiple calls', () => {
    stateManager.incrementMergedCount('owner/repo');
    stateManager.incrementMergedCount('owner/repo');
    expect(stateManager.getRepoScore('owner/repo')!.mergedPRCount).toBe(2);
  });

  it('should preserve existing signals when incrementing merged count', () => {
    stateManager.updateRepoScore('owner/repo', {
      signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false },
    });
    stateManager.incrementMergedCount('owner/repo');
    const score = stateManager.getRepoScore('owner/repo')!;
    expect(score.signals.isResponsive).toBe(true);
    expect(score.signals.hasActiveMaintainers).toBe(true);
    expect(score.mergedPRCount).toBe(1);
  });

  it('should create record and set count to 1 for new repo on incrementClosedCount', () => {
    stateManager.incrementClosedCount('owner/new-repo');
    const score = stateManager.getRepoScore('owner/new-repo')!;
    expect(score).toBeDefined();
    expect(score.closedWithoutMergeCount).toBe(1);
  });

  it('should handle mixed increment and closed operations on same repo', () => {
    stateManager.incrementMergedCount('owner/repo');
    stateManager.incrementClosedCount('owner/repo');
    const score = stateManager.getRepoScore('owner/repo')!;
    expect(score.mergedPRCount).toBe(1);
    expect(score.closedWithoutMergeCount).toBe(1);
  });
});

describe('StateManager event logging', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should append events and include them in state', () => {
    stateManager.appendEvent('daily_check', { runId: 'abc' });
    const state = stateManager.getState();
    expect(state.events).toHaveLength(1);
    expect(state.events[0].type).toBe('daily_check');
    expect(state.events[0].data).toEqual({ runId: 'abc' });
    expect(state.events[0].id).toMatch(/^evt_/);
    expect(typeof state.events[0].at).toBe('string');
  });

  it('should filter events by type with getEventsByType', () => {
    stateManager.appendEvent('daily_check', { day: 1 });
    stateManager.appendEvent('pr_merged', { url: 'https://github.com/a/b/pull/1' });
    stateManager.appendEvent('daily_check', { day: 2 });
    stateManager.appendEvent('pr_closed', { url: 'https://github.com/a/b/pull/2' });
    stateManager.appendEvent('daily_check', { day: 3 });

    const dailyChecks = stateManager.getEventsByType('daily_check');
    expect(dailyChecks).toHaveLength(3);
    expect(dailyChecks.every((e) => e.type === 'daily_check')).toBe(true);

    const merged = stateManager.getEventsByType('pr_merged');
    expect(merged).toHaveLength(1);

    const closed = stateManager.getEventsByType('pr_closed');
    expect(closed).toHaveLength(1);

    const tracked = stateManager.getEventsByType('pr_tracked');
    expect(tracked).toHaveLength(0);
  });

  it('should cap events at MAX_EVENTS (1000)', () => {
    // Append 1010 events
    for (let i = 0; i < 1010; i++) {
      stateManager.appendEvent('daily_check', { index: i });
    }

    const state = stateManager.getState();
    expect(state.events).toHaveLength(1000);
    // The oldest events should be pruned; the last event should have index 1009
    expect(state.events[state.events.length - 1].data.index).toBe(1009);
    // The first retained event should have index 10 (events 0-9 were pruned)
    expect(state.events[0].data.index).toBe(10);
  });

  it('should filter events by date range with getEventsInRange', () => {
    // Manually push events with controlled timestamps to avoid timing issues
    const state = stateManager.getState() as {
      events: Array<{ id: string; type: StateEventType; at: string; data: Record<string, unknown> }>;
    };

    state.events.push(
      { id: 'evt_1', type: 'daily_check', at: '2024-01-01T00:00:00Z', data: { day: 'jan1' } },
      { id: 'evt_2', type: 'pr_merged', at: '2024-01-15T00:00:00Z', data: { day: 'jan15' } },
      { id: 'evt_3', type: 'daily_check', at: '2024-02-01T00:00:00Z', data: { day: 'feb1' } },
      { id: 'evt_4', type: 'pr_closed', at: '2024-03-01T00:00:00Z', data: { day: 'mar1' } },
    );

    // Range: Jan 10 - Feb 15 should include jan15 and feb1
    const rangeEvents = stateManager.getEventsInRange(
      new Date('2024-01-10T00:00:00Z'),
      new Date('2024-02-15T00:00:00Z'),
    );
    expect(rangeEvents).toHaveLength(2);
    expect(rangeEvents[0].data.day).toBe('jan15');
    expect(rangeEvents[1].data.day).toBe('feb1');

    // Range: entire year should include all 4
    const allEvents = stateManager.getEventsInRange(new Date('2023-12-01T00:00:00Z'), new Date('2024-12-31T00:00:00Z'));
    expect(allEvents).toHaveLength(4);

    // Range: before all events should include none
    const noEvents = stateManager.getEventsInRange(new Date('2023-01-01T00:00:00Z'), new Date('2023-12-31T00:00:00Z'));
    expect(noEvents).toHaveLength(0);
  });
});

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

// ── Snooze / Unsnooze PR CI Failures ──────────────────────────────────────
describe('snoozePR / unsnoozePR / isSnoozed / expireSnoozes', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should snooze a PR and mark it as snoozed', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.snoozePR(url, 'upstream issue', 7)).toBe(true);
    expect(stateManager.isSnoozed(url)).toBe(true);
  });

  it('should return false when snoozing an already-snoozed PR (idempotent)', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.snoozePR(url, 'upstream issue', 7);
    expect(stateManager.snoozePR(url, 'different reason', 14)).toBe(false);
  });

  it('should store snooze metadata correctly', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    const before = Date.now();
    stateManager.snoozePR(url, 'flaky infra', 14);
    const after = Date.now();

    const info = stateManager.getSnoozeInfo(url);
    expect(info).toBeDefined();
    expect(info!.reason).toBe('flaky infra');

    const snoozedAt = new Date(info!.snoozedAt).getTime();
    expect(snoozedAt).toBeGreaterThanOrEqual(before);
    expect(snoozedAt).toBeLessThanOrEqual(after);

    const expiresAt = new Date(info!.expiresAt).getTime();
    const expectedExpiry = snoozedAt + 14 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBe(expectedExpiry);
  });

  it('should unsnooze a snoozed PR', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.snoozePR(url, 'upstream issue', 7);
    expect(stateManager.unsnoozePR(url)).toBe(true);
    expect(stateManager.isSnoozed(url)).toBe(false);
    expect(stateManager.getSnoozeInfo(url)).toBeUndefined();
  });

  it('should return false when unsnoozing a PR that is not snoozed', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.unsnoozePR(url)).toBe(false);
  });

  it('should report expired snoozes as not snoozed via isSnoozed', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.snoozePR(url, 'test', 7);

    // Manually set expiresAt to the past
    const config = stateManager.getState().config as any;
    config.snoozedPRs[url].expiresAt = '2020-01-01T00:00:00.000Z';

    expect(stateManager.isSnoozed(url)).toBe(false);
  });

  it('should expire snoozes that are past their expiresAt', () => {
    const url1 = 'https://github.com/owner/repo/pull/1';
    const url2 = 'https://github.com/owner/repo/pull/2';
    stateManager.snoozePR(url1, 'expired one', 7);
    stateManager.snoozePR(url2, 'still active', 7);

    // Set url1 to expired
    const config = stateManager.getState().config as any;
    config.snoozedPRs[url1].expiresAt = '2020-01-01T00:00:00.000Z';

    const expired = stateManager.expireSnoozes();
    expect(expired).toEqual([url1]);
    expect(stateManager.getSnoozeInfo(url1)).toBeUndefined();
    expect(stateManager.getSnoozeInfo(url2)).toBeDefined();
  });

  it('should return empty array when no snoozes have expired', () => {
    const url = 'https://github.com/owner/repo/pull/1';
    stateManager.snoozePR(url, 'test', 7);
    const expired = stateManager.expireSnoozes();
    expect(expired).toEqual([]);
  });

  it('should return empty array when there are no snoozes', () => {
    expect(stateManager.expireSnoozes()).toEqual([]);
  });

  it('should handle multiple snoozed PRs independently', () => {
    const url1 = 'https://github.com/owner/repo/pull/1';
    const url2 = 'https://github.com/owner/repo/pull/2';
    stateManager.snoozePR(url1, 'reason 1', 7);
    stateManager.snoozePR(url2, 'reason 2', 14);
    expect(stateManager.isSnoozed(url1)).toBe(true);
    expect(stateManager.isSnoozed(url2)).toBe(true);

    stateManager.unsnoozePR(url1);
    expect(stateManager.isSnoozed(url1)).toBe(false);
    expect(stateManager.isSnoozed(url2)).toBe(true);
  });

  it('should handle isSnoozed when snoozedPRs is undefined', () => {
    (stateManager.getState().config as any).snoozedPRs = undefined;
    expect(stateManager.isSnoozed('https://github.com/owner/repo/pull/1')).toBe(false);
  });

  it('should handle getSnoozeInfo when snoozedPRs is undefined', () => {
    (stateManager.getState().config as any).snoozedPRs = undefined;
    expect(stateManager.getSnoozeInfo('https://github.com/owner/repo/pull/1')).toBeUndefined();
  });

  it('should initialize snoozedPRs object when first snoozing', () => {
    (stateManager.getState().config as any).snoozedPRs = undefined;
    const url = 'https://github.com/owner/repo/pull/1';
    expect(stateManager.snoozePR(url, 'test', 7)).toBe(true);
    expect(stateManager.getState().config.snoozedPRs).toBeDefined();
    expect(Object.keys(stateManager.getState().config.snoozedPRs!)).toHaveLength(1);
  });

  it('should handle expireSnoozes when snoozedPRs is undefined', () => {
    (stateManager.getState().config as any).snoozedPRs = undefined;
    expect(stateManager.expireSnoozes()).toEqual([]);
  });
});

// ── getStats() exclusion filtering (#211) ──────────────────────────────────
describe('StateManager getStats exclusion filtering', () => {
  let stateManager: StateManager;

  beforeEach(() => {
    stateManager = new StateManager(true);
  });

  it('should exclude repos in excludeRepos from merged/closed totals', () => {
    stateManager.updateRepoScore('owner/included', { mergedPRCount: 3, closedWithoutMergeCount: 1 });
    stateManager.updateRepoScore('owner/excluded', { mergedPRCount: 10, closedWithoutMergeCount: 5 });
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(3);
    expect(stats.closedPRs).toBe(1);
    expect(stats.totalTracked).toBe(1);
  });

  it('should exclude all repos for an org in excludeOrgs', () => {
    stateManager.updateRepoScore('bad-org/repo-a', { mergedPRCount: 5 });
    stateManager.updateRepoScore('bad-org/repo-b', { mergedPRCount: 3 });
    stateManager.updateRepoScore('good-org/repo-c', { mergedPRCount: 2 });
    stateManager.updateConfig({ excludeOrgs: ['bad-org'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(2);
    expect(stats.totalTracked).toBe(1);
  });

  it('should match excludeOrgs case-insensitively', () => {
    stateManager.updateRepoScore('MyOrg/repo', { mergedPRCount: 4 });
    stateManager.updateConfig({ excludeOrgs: ['myorg'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(0);
    expect(stats.totalTracked).toBe(0);
  });

  it('should match excludeRepos case-insensitively', () => {
    stateManager.updateRepoScore('facebook/react', { mergedPRCount: 5 });
    stateManager.updateConfig({ excludeRepos: ['Facebook/React'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(0);
    expect(stats.totalTracked).toBe(0);
  });

  it('should exclude by both excludeRepos and excludeOrgs simultaneously', () => {
    stateManager.updateRepoScore('org-a/repo-1', { mergedPRCount: 1 });
    stateManager.updateRepoScore('org-b/repo-2', { mergedPRCount: 2 });
    stateManager.updateRepoScore('org-c/repo-3', { mergedPRCount: 3 });
    stateManager.updateConfig({ excludeRepos: ['org-a/repo-1'], excludeOrgs: ['org-b'] });

    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(3);
    expect(stats.totalTracked).toBe(1);
  });

  it('should work when excludeOrgs is undefined', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2 });
    // excludeOrgs is not set (undefined) — should not crash
    const stats = stateManager.getStats();
    expect(stats.mergedPRs).toBe(2);
    expect(stats.totalTracked).toBe(1);
  });

  it('should filter trustedProjects count by excludeRepos', () => {
    stateManager.addTrustedProject('owner/kept');
    stateManager.addTrustedProject('owner/excluded');
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    expect(stats.trustedProjects).toBe(1);
  });

  it('should filter trustedProjects count by excludeOrgs', () => {
    stateManager.addTrustedProject('bad-org/repo-a');
    stateManager.addTrustedProject('bad-org/repo-b');
    stateManager.addTrustedProject('good-org/repo-c');
    stateManager.updateConfig({ excludeOrgs: ['bad-org'] });

    const stats = stateManager.getStats();
    expect(stats.trustedProjects).toBe(1);
  });

  it('should compute correct mergeRate excluding filtered repos', () => {
    stateManager.updateRepoScore('owner/included', { mergedPRCount: 1, closedWithoutMergeCount: 1 });
    stateManager.updateRepoScore('owner/excluded', { mergedPRCount: 100, closedWithoutMergeCount: 0 });
    stateManager.updateConfig({ excludeRepos: ['owner/excluded'] });

    const stats = stateManager.getStats();
    expect(stats.mergeRate).toBe('50.0%');
  });

  it('should return all repos when no exclusions are set', () => {
    stateManager.updateRepoScore('a/b', { mergedPRCount: 2 });
    stateManager.updateRepoScore('c/d', { mergedPRCount: 1 });

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
});

// ── cleanupExcludedData (#213) ──────────────────────────────────────────────
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

  it('should remove matching repo from repoScores', () => {
    stateManager.updateRepoScore('owner/repo-a', { mergedPRCount: 1 });
    stateManager.updateRepoScore('owner/repo-b', { mergedPRCount: 2 });
    stateManager.cleanupExcludedData(['owner/repo-a'], []);

    expect(stateManager.getState().repoScores['owner/repo-a']).toBeUndefined();
    expect(stateManager.getState().repoScores['owner/repo-b']).toBeDefined();
  });

  it('should remove all org repos from trustedProjects and repoScores', () => {
    stateManager.addTrustedProject('bad-org/repo-a');
    stateManager.addTrustedProject('bad-org/repo-b');
    stateManager.addTrustedProject('good-org/repo-c');
    stateManager.updateRepoScore('bad-org/repo-a', { mergedPRCount: 1 });
    stateManager.updateRepoScore('bad-org/repo-b', { mergedPRCount: 2 });
    stateManager.updateRepoScore('good-org/repo-c', { mergedPRCount: 3 });

    stateManager.cleanupExcludedData([], ['bad-org']);

    expect(stateManager.getState().config.trustedProjects).toEqual(['good-org/repo-c']);
    expect(stateManager.getState().repoScores['bad-org/repo-a']).toBeUndefined();
    expect(stateManager.getState().repoScores['bad-org/repo-b']).toBeUndefined();
    expect(stateManager.getState().repoScores['good-org/repo-c']).toBeDefined();
  });

  it('should match repo name case-insensitively', () => {
    stateManager.addTrustedProject('facebook/react');
    stateManager.updateRepoScore('facebook/react', { mergedPRCount: 1 });

    stateManager.cleanupExcludedData(['Facebook/React'], []);

    expect(stateManager.getState().config.trustedProjects).toEqual([]);
    expect(stateManager.getState().repoScores['facebook/react']).toBeUndefined();
  });

  it('should match org name case-insensitively', () => {
    stateManager.addTrustedProject('MyOrg/repo');
    stateManager.updateRepoScore('MyOrg/repo', { mergedPRCount: 1 });

    stateManager.cleanupExcludedData([], ['myorg']);

    expect(stateManager.getState().config.trustedProjects).toEqual([]);
    expect(stateManager.getState().repoScores['MyOrg/repo']).toBeUndefined();
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
    expect(Object.keys(stateManager.getState().repoScores)).toEqual(['org-c/repo-3']);
  });
});

describe('Concurrent State Write Protection', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-test-'));
  });

  afterEach(() => {
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('atomicWriteFileSync', () => {
    it('should write file content correctly', () => {
      const filePath = path.join(tmpDir, 'test.json');
      const data = JSON.stringify({ hello: 'world' }, null, 2);

      atomicWriteFileSync(filePath, data);

      expect(fs.readFileSync(filePath, 'utf-8')).toBe(data);
    });

    it('should not leave a .tmp file after successful write', () => {
      const filePath = path.join(tmpDir, 'test.json');
      const tmpPath = filePath + '.tmp';

      atomicWriteFileSync(filePath, '{"ok":true}');

      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(tmpPath)).toBe(false);
    });

    it('should overwrite existing file atomically', () => {
      const filePath = path.join(tmpDir, 'test.json');
      fs.writeFileSync(filePath, '{"version":1}');

      atomicWriteFileSync(filePath, '{"version":2}');

      expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"version":2}');
    });

    it('should apply the specified file mode', () => {
      const filePath = path.join(tmpDir, 'test.json');

      atomicWriteFileSync(filePath, '{}', 0o600);

      const stats = fs.statSync(filePath);
      // Check owner read/write bits (mask out non-owner bits)
      expect(stats.mode & 0o777).toBe(0o600);
    });
  });

  describe('acquireLock / releaseLock', () => {
    it('should create a lock file on acquire and remove it on release', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');

      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const lockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(lockData.pid).toBe(process.pid);
      expect(typeof lockData.timestamp).toBe('number');

      releaseLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(false);
    });

    it('should throw when lock is held by another process', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a lock from another process that is NOT stale
      const lockData = JSON.stringify({ pid: 999999, timestamp: Date.now() });
      fs.writeFileSync(lockPath, lockData, { flag: 'wx' });

      expect(() => acquireLock(lockPath)).toThrow('State file is locked by another process');

      // Clean up (use unlinkSync directly since releaseLock checks PID ownership)
      fs.unlinkSync(lockPath);
    });

    it('should recover from stale locks', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a stale lock (timestamp 60 seconds ago, well past the 30s timeout)
      const staleLockData = JSON.stringify({ pid: 999999, timestamp: Date.now() - 60_000 });
      fs.writeFileSync(lockPath, staleLockData, { flag: 'wx' });

      // Should succeed because the lock is stale
      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const newLockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(newLockData.pid).toBe(process.pid);

      releaseLock(lockPath);
    });

    it('should recover from corrupt lock files', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Write invalid JSON to simulate a corrupt lock file
      fs.writeFileSync(lockPath, 'NOT VALID JSON', { flag: 'wx' });

      // Should succeed because corrupt locks are treated as stale
      acquireLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      const newLockData = JSON.parse(fs.readFileSync(lockPath, 'utf-8'));
      expect(newLockData.pid).toBe(process.pid);

      releaseLock(lockPath);
    });

    it('should not release a lock owned by another process', () => {
      const lockPath = path.join(tmpDir, 'state.json.lock');
      // Simulate a lock from another process
      const lockData = JSON.stringify({ pid: 999999, timestamp: Date.now() });
      fs.writeFileSync(lockPath, lockData, { flag: 'wx' });

      // releaseLock should not remove it because PID doesn't match
      releaseLock(lockPath);
      expect(fs.existsSync(lockPath)).toBe(true);

      // Clean up
      fs.unlinkSync(lockPath);
    });

    it('should silently handle releasing a non-existent lock', () => {
      const lockPath = path.join(tmpDir, 'non-existent.lock');
      // Should not throw
      expect(() => releaseLock(lockPath)).not.toThrow();
    });
  });
});

// ─── File-System Persistence Tests ───────────────────────────────────────────
//
// These tests exercise StateManager in non-inMemory mode, verifying that state
// is actually written to and read from disk. Each test suite uses its own
// isolated temp directory so tests are fully independent.
//
// The vi.mock and mockTmpDir variable are declared at the top of this file so
// they are in scope for the mock factory. See the "File-System Persistence Mock
// Setup" section near the top of the file.
// ─────────────────────────────────────────────────────────────────────────────

// Shared config shape used by both makeV2State and makeV1State.
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
    snoozedPRs: {},
  };
}

// Helper: build a minimal valid v2 state object for writing to disk in tests.
function makeV2State(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
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

// Helper: build a minimal valid v1 state for migration tests.
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

describe('StateManager file-system persistence (save / load)', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-persist-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should write state.json to disk when save() is called', () => {
    const sm = new StateManager(false);
    sm.updateConfig({ githubUsername: 'alice' });
    sm.save();

    const statePath = path.join(mockTmpDir, 'state.json');
    expect(fs.existsSync(statePath)).toBe(true);
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.config.githubUsername).toBe('alice');
  });

  it('should set file permissions to 0o600 when writing state', () => {
    const sm = new StateManager(false);
    sm.save();

    const statePath = path.join(mockTmpDir, 'state.json');
    const stats = fs.statSync(statePath);
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it('should update lastRunAt on every save()', () => {
    const sm = new StateManager(false);
    const before = new Date().toISOString();
    sm.save();
    const after = new Date().toISOString();

    const statePath = path.join(mockTmpDir, 'state.json');
    const written = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(written.lastRunAt >= before).toBe(true);
    expect(written.lastRunAt <= after).toBe(true);
  });

  it('should load previously saved state from disk', () => {
    // First instance: save some state
    const sm1 = new StateManager(false);
    sm1.updateConfig({ githubUsername: 'bob' });
    sm1.updateRepoScore('owner/repo', { mergedPRCount: 3 });
    sm1.save();

    // Second instance reading the same file
    const sm2 = new StateManager(false);
    const state = sm2.getState();
    expect(state.config.githubUsername).toBe('bob');
    expect(state.repoScores['owner/repo']).toBeDefined();
    expect(state.repoScores['owner/repo'].mergedPRCount).toBe(3);
  });

  it('should create a backup of the existing state before saving a new one', () => {
    const sm = new StateManager(false);
    sm.save(); // First save: no prior state → no backup yet

    sm.updateConfig({ githubUsername: 'carol' });
    sm.save(); // Second save: existing state.json → creates a backup

    const backupDir = path.join(mockTmpDir, 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
  });

  it('should set backup file permissions to 0o600', () => {
    const sm = new StateManager(false);
    sm.save(); // Create the initial state.json

    sm.updateConfig({ githubUsername: 'dave' });
    sm.save(); // Triggers backup of first save

    const backupDir = path.join(mockTmpDir, 'backups');
    const backups = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-') && f.endsWith('.json'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    for (const backup of backups) {
      const stats = fs.statSync(path.join(backupDir, backup));
      expect(stats.mode & 0o777).toBe(0o600);
    }
  });

  it('should return fresh state when no state file exists', () => {
    // No state.json pre-created — should initialize from scratch
    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);

    expect(typeof state.config).toBe('object');
  });

  it('should not leave a .tmp file on disk after save()', () => {
    const sm = new StateManager(false);
    sm.save();

    const tmpFile = path.join(mockTmpDir, 'state.json.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('should prune old backups keeping only the 10 most recent', () => {
    // Pre-populate 12 fake backup files with distinct timestamps
    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 12; i++) {
      const name = `state-2024-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z-aabbcc.json`;
      fs.writeFileSync(path.join(backupDir, name), JSON.stringify(makeV2State()));
    }

    // Write state.json so save() has something to back up, then save to trigger cleanup
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(makeV2State()), { mode: 0o600 });

    const sm = new StateManager(false);
    sm.save(); // Backs up the existing state.json (13 total) and then prunes to 10

    const remaining = fs.readdirSync(backupDir).filter((f) => f.startsWith('state-'));
    // 12 pre-existing + 1 new backup from save() = 13 total, pruned to exactly 10
    expect(remaining.length).toBe(10);
  });
});

describe('StateManager recovery from corrupt state files', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-state-corrupt-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
    mockTmpDir = '';
  });

  it('should start fresh when state.json contains invalid JSON', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, '{ this is not valid json }', { mode: 0o600 });

    // No backup exists → falls back to fresh state
    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
  });

  it('should restore from backup when state.json is corrupt but a valid backup exists', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    // Create a valid backup with a custom username
    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const fullBackup = makeV2State();
    (fullBackup.config as Record<string, unknown>)['githubUsername'] = 'restored-user';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'), JSON.stringify(fullBackup), {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.config.githubUsername).toBe('restored-user');
  });

  it('should overwrite corrupt state.json with restored backup contents', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const fullBackup = makeV2State();
    (fullBackup.config as Record<string, unknown>)['githubUsername'] = 'from-backup';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc123.json'), JSON.stringify(fullBackup), {
      mode: 0o600,
    });

    new StateManager(false);

    // state.json should now contain the restored backup data
    const restoredOnDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(restoredOnDisk.config.githubUsername).toBe('from-backup');
  });

  it('should skip corrupt backups and use the next valid one', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // Newer backup (sorted last = most recent after reverse) is corrupt
    fs.writeFileSync(path.join(backupDir, 'state-2024-02-01T00-00-00-000Z-zzz000.json'), 'ALSO CORRUPT', {
      mode: 0o600,
    });

    // Older backup is valid
    const validBackup = makeV2State();
    (validBackup.config as Record<string, unknown>)['githubUsername'] = 'valid-older-backup';
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-aaa000.json'), JSON.stringify(validBackup), {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    expect(sm.getState().config.githubUsername).toBe('valid-older-backup');
  });

  it('should start fresh when both state.json and all backups are corrupt', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    fs.writeFileSync(statePath, 'CORRUPT', { mode: 0o600 });

    const backupDir = path.join(mockTmpDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'state-2024-01-01T00-00-00-000Z-abc000.json'), 'ALSO CORRUPT', {
      mode: 0o600,
    });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
  });

  it('should start fresh when state.json has invalid structure (missing required fields)', () => {
    const statePath = path.join(mockTmpDir, 'state.json');
    // Valid JSON but missing required fields (no version, no config)
    fs.writeFileSync(statePath, JSON.stringify({ hello: 'world' }), { mode: 0o600 });

    const sm = new StateManager(false);
    const state = sm.getState();
    expect(state.version).toBe(2);
    expect(typeof state.config).toBe('object');
  });
});

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
    expect(state.version).toBe(2);

    // Verify migration was persisted to disk
    const onDisk = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    expect(onDisk.version).toBe(2);
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
    expect(sm.getState().version).toBe(2);
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
    // Should have been migrated to v2 during restore
    expect(sm.getState().version).toBe(2);
  });
});

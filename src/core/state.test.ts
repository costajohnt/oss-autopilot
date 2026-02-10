/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from './state.js';
import { TrackedPR, StateEventType } from './types.js';

describe('StateManager', () => {
  let stateManager: StateManager;

  // Factory function to create a fresh mock PR for each test
  const createMockPR = (overrides: Partial<TrackedPR> = {}): TrackedPR => ({
    id: 123,
    url: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Test PR',
    status: 'open',
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
  });

  beforeEach(() => {
    // Create a fresh in-memory state manager for each test
    stateManager = new StateManager(true);
  });

  describe('PR Management', () => {
    it('should add a PR to active list', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(1);
      expect(state.activePRs[0].url).toBe(mockPR.url);
    });

    it('should not add duplicate PRs', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.addActivePR(mockPR);
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(1);
    });

    it('should update PR properties', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.updatePR(mockPR.url, { hasUnreadComments: true });
      const state = stateManager.getState();
      expect(state.activePRs[0].hasUnreadComments).toBe(true);
    });

    it('should move PR to merged', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToMerged(mockPR.url);
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(0);
      expect(state.mergedPRs).toHaveLength(1);
      expect(state.mergedPRs[0].status).toBe('merged');
    });

    it('should move PR to closed', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToClosed(mockPR.url);
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(0);
      expect(state.closedPRs).toHaveLength(1);
      expect(state.closedPRs[0].status).toBe('closed');
    });

    it('should move PR to dormant', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToDormant(mockPR.url);
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(0);
      expect(state.dormantPRs).toHaveLength(1);
      expect(state.dormantPRs[0].activityStatus).toBe('dormant');
    });

    it('should reactivate dormant PR', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToDormant(mockPR.url);
      stateManager.reactivatePR(mockPR.url);
      const state = stateManager.getState();
      expect(state.dormantPRs).toHaveLength(0);
      expect(state.activePRs).toHaveLength(1);
      expect(state.activePRs[0].activityStatus).toBe('active');
    });

    it('should move dormant PR directly to merged', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToDormant(mockPR.url);
      stateManager.moveDormantPRToMerged(mockPR.url);
      const state = stateManager.getState();
      expect(state.dormantPRs).toHaveLength(0);
      expect(state.mergedPRs).toHaveLength(1);
    });

    it('should untrack a PR', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      const removed = stateManager.untrackPR(mockPR.url);
      expect(removed).toBe(true);
      expect(stateManager.getState().activePRs).toHaveLength(0);
    });

    it('should untrack a dormant PR', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToDormant(mockPR.url);
      const removed = stateManager.untrackPR(mockPR.url);
      expect(removed).toBe(true);
      expect(stateManager.getState().dormantPRs).toHaveLength(0);
    });

    it('should return false when untracking non-existent PR', () => {
      const removed = stateManager.untrackPR('https://github.com/fake/url');
      expect(removed).toBe(false);
    });
  });

  describe('Mark as Read', () => {
    it('should mark PR as read', () => {
      const mockPR = createMockPR({ hasUnreadComments: true, activityStatus: 'needs_response' });
      stateManager.addActivePR(mockPR);
      const marked = stateManager.markPRAsRead(mockPR.url);
      expect(marked).toBe(true);
      const state = stateManager.getState();
      expect(state.activePRs[0].hasUnreadComments).toBe(false);
      expect(state.activePRs[0].activityStatus).toBe('active');
    });

    it('should mark all PRs as read', () => {
      const pr1 = createMockPR({ hasUnreadComments: true });
      const pr2 = createMockPR({ id: 456, url: 'https://github.com/owner/repo/pull/2', number: 2, hasUnreadComments: true });
      stateManager.addActivePR(pr1);
      stateManager.addActivePR(pr2);
      const count = stateManager.markAllPRsAsRead();
      expect(count).toBe(2);
      const state = stateManager.getState();
      expect(state.activePRs.every(pr => !pr.hasUnreadComments)).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should calculate correct merge rate', () => {
      // Add and merge a PR
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToMerged(mockPR.url);

      // Add and close another PR
      const pr2 = createMockPR({ id: 456, url: 'https://github.com/owner/repo/pull/2', number: 2 });
      stateManager.addActivePR(pr2);
      stateManager.movePRToClosed(pr2.url);

      const stats = stateManager.getStats();
      expect(stats.mergeRate).toBe('50.0%');
    });

    it('should return 0% merge rate when no completed PRs', () => {
      const stats = stateManager.getStats();
      expect(stats.mergeRate).toBe('0.0%');
    });

    it('should return 0 for needsResponse in v2 (PRs fetched fresh from GitHub)', () => {
      // In v2, PRs are not tracked locally - they're fetched fresh
      // So needsResponse is always 0 in getStats()
      // The actual count comes from the fresh fetch in daily command
      const pr1 = createMockPR({ hasUnreadComments: true });
      const pr2 = createMockPR({ id: 456, url: 'https://github.com/owner/repo/pull/2', number: 2, hasUnreadComments: false });
      stateManager.addActivePR(pr1);
      stateManager.addActivePR(pr2);
      const stats = stateManager.getStats();
      // v2: needsResponse is 0 because we don't track PRs locally anymore
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
      expect(state.config.trustedProjects.filter(p => p === 'owner/repo')).toHaveLength(1);
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
    it('should handle updatePR on non-existent PR silently', () => {
      // Should not throw
      stateManager.updatePR('https://nonexistent.url', { hasUnreadComments: true });
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(0);
    });

    it('should handle markPRAsRead on non-existent PR', () => {
      const result = stateManager.markPRAsRead('https://nonexistent.url');
      expect(result).toBe(false);
    });

    it('should handle movePRToMerged on non-existent PR silently', () => {
      // Should not throw
      stateManager.movePRToMerged('https://nonexistent.url');
      const state = stateManager.getState();
      expect(state.mergedPRs).toHaveLength(0);
    });

    it('should handle reactivatePR on non-existent dormant PR silently', () => {
      // Should not throw
      stateManager.reactivatePR('https://nonexistent.url');
      const state = stateManager.getState();
      expect(state.activePRs).toHaveLength(0);
    });

    it('should preserve updated PR data when moving to dormant', () => {
      const mockPR = createMockPR({ daysSinceActivity: 5 });
      stateManager.addActivePR(mockPR);
      stateManager.updatePR(mockPR.url, { daysSinceActivity: 35 });
      stateManager.movePRToDormant(mockPR.url);
      const state = stateManager.getState();
      expect(state.dormantPRs[0].daysSinceActivity).toBe(35);
    });

    it('should handle moveDormantPRToClosed', () => {
      const mockPR = createMockPR();
      stateManager.addActivePR(mockPR);
      stateManager.movePRToDormant(mockPR.url);
      stateManager.moveDormantPRToClosed(mockPR.url);
      const state = stateManager.getState();
      expect(state.dormantPRs).toHaveLength(0);
      expect(state.closedPRs).toHaveLength(1);
      expect(state.closedPRs[0].status).toBe('closed');
    });

    it('should isolate state between instances', () => {
      const sm1 = new StateManager(true);
      const sm2 = new StateManager(true);
      sm1.addActivePR(createMockPR());
      expect(sm1.getState().activePRs).toHaveLength(1);
      expect(sm2.getState().activePRs).toHaveLength(0);
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
    stateManager.updateRepoScore('owner/repo', { signals: { isResponsive: true, hasActiveMaintainers: true, hasHostileComments: false } });
    expect(stateManager.getRepoScore('owner/repo')!.score).toBe(6);
  });

  it('should subtract -2 for hostile signal', () => {
    stateManager.updateRepoScore('owner/repo', { signals: { hasHostileComments: true, hasActiveMaintainers: true, isResponsive: false } });
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
    expect(Array.isArray(state.activePRs)).toBe(true);
    expect(Array.isArray(state.mergedPRs)).toBe(true);
    expect(Array.isArray(state.closedPRs)).toBe(true);
    expect(Array.isArray(state.dormantPRs)).toBe(true);
    expect(typeof state.lastRunAt).toBe('string');
  });

  it('should maintain valid structure after operations', () => {
    const mockPR: TrackedPR = {
      id: 999,
      url: 'https://github.com/owner/repo/pull/99',
      repo: 'owner/repo',
      number: 99,
      title: 'Validity test PR',
      status: 'open',
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
    stateManager.addActivePR(mockPR);
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2 });
    stateManager.appendEvent('daily_check', { note: 'test' });

    const state = stateManager.getState();
    expect(state.version).toBe(2);
    expect(typeof state.config).toBe('object');
    expect(typeof state.repoScores).toBe('object');
    expect(Array.isArray(state.events)).toBe(true);
    expect(state.activePRs).toHaveLength(1);
    expect(Object.keys(state.repoScores)).toHaveLength(1);
    // events includes the pr_tracked event from addActivePR + the daily_check
    expect(state.events.length).toBeGreaterThanOrEqual(2);
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
    expect(dailyChecks.every(e => e.type === 'daily_check')).toBe(true);

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
    const state = stateManager.getState() as { events: Array<{ id: string; type: StateEventType; at: string; data: Record<string, unknown> }> };

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
    const allEvents = stateManager.getEventsInRange(
      new Date('2023-12-01T00:00:00Z'),
      new Date('2024-12-31T00:00:00Z'),
    );
    expect(allEvents).toHaveLength(4);

    // Range: before all events should include none
    const noEvents = stateManager.getEventsInRange(
      new Date('2023-01-01T00:00:00Z'),
      new Date('2023-12-31T00:00:00Z'),
    );
    expect(noEvents).toHaveLength(0);
  });
});

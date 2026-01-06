/**
 * Tests for StateManager
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StateManager } from './state.js';
import { TrackedPR } from './types.js';

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

    it('should count needs response PRs', () => {
      const pr1 = createMockPR({ hasUnreadComments: true });
      const pr2 = createMockPR({ id: 456, url: 'https://github.com/owner/repo/pull/2', number: 2, hasUnreadComments: false });
      stateManager.addActivePR(pr1);
      stateManager.addActivePR(pr2);
      const stats = stateManager.getStats();
      expect(stats.needsResponse).toBe(1);
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

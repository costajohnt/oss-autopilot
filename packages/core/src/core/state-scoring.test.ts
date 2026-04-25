/**
 * Tests for StateManager scoring, repo queries, and stats
 * (extracted from state.test.ts)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StateManager } from './state.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ─── File-System Persistence Mock Setup ──────────────────────────────────────
//
// Needed by getHighScoringRepos / getLowScoringRepos / getStats which use
// new StateManager(false) and redirect file-system paths to temp dirs.
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

  it('should have required v3 structure on initialization', () => {
    const state = stateManager.getState();
    expect(state.version).toBe(3);
    expect(state.config).toBeDefined();
    expect(typeof state.config).toBe('object');
    expect(state.repoScores).toBeDefined();
    expect(typeof state.repoScores).toBe('object');
    expect(Array.isArray(state.activeIssues)).toBe(true);
    expect(typeof state.lastRunAt).toBe('string');
  });

  it('should maintain valid structure after operations', () => {
    stateManager.updateRepoScore('owner/repo', { mergedPRCount: 2 });

    const state = stateManager.getState();
    expect(state.version).toBe(3);
    expect(typeof state.config).toBe('object');
    expect(typeof state.repoScores).toBe('object');
    expect(Object.keys(state.repoScores)).toHaveLength(1);
  });

  it('should aggregate stats correctly from repo scores', () => {
    stateManager.updateRepoScore('owner/repo-a', {
      mergedPRCount: 3,
      closedWithoutMergeCount: 1,
      stargazersCount: 100,
    });
    stateManager.updateRepoScore('owner/repo-b', {
      mergedPRCount: 2,
      closedWithoutMergeCount: 0,
      stargazersCount: 200,
    });

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

describe('getHighScoringRepos', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
  });

  it('should return repos at or above the given threshold, sorted descending', () => {
    const sm = new StateManager(false);
    // Base score 5 - 3 closed = 2 (below threshold)
    sm.updateRepoScore('low/repo', { closedWithoutMergeCount: 3, signals: {} });
    // Base score 5 + merge bonus = 8 (above threshold)
    sm.updateRepoScore('high/repo', { mergedPRCount: 2, signals: {} });

    const highRepos = sm.getHighScoringRepos(5);
    expect(highRepos.length).toBe(1);
    expect(highRepos[0]).toBe('high/repo');
  });
});

describe('getLowScoringRepos', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
  });

  it('should return repos at or below the given threshold, sorted ascending', () => {
    const sm = new StateManager(false);
    // Base score is 5, with 3 closed-without-merge => 5-3=2
    sm.updateRepoScore('low/repo', { closedWithoutMergeCount: 3, signals: {} });
    // With 2 merged PRs => 5 + log2(3)*2 ≈ 5+3=8
    sm.updateRepoScore('high/repo', { mergedPRCount: 2, signals: {} });

    const lowRepos = sm.getLowScoringRepos(3);
    // low/repo has score 2 which is <= 3
    expect(lowRepos.length).toBe(1);
    expect(lowRepos[0]).toBe('low/repo');
  });

  it('should use config threshold when no argument provided', () => {
    const sm = new StateManager(false);
    // Base score 5 - 3 closed = 2 (below default threshold of 4)
    sm.updateRepoScore('repo/a', { closedWithoutMergeCount: 3, signals: {} });
    // Base score 5 + merge bonus = 8 (above threshold)
    sm.updateRepoScore('repo/b', { mergedPRCount: 2, signals: {} });

    // Default minRepoScoreThreshold is 4 from INITIAL_STATE
    const lowRepos = sm.getLowScoringRepos();
    expect(lowRepos).toContain('repo/a');
    expect(lowRepos).not.toContain('repo/b');
  });

  it('should exclude repos with stale scores (>30 days) so they can be re-evaluated (#487)', () => {
    const sm = new StateManager(false);
    // Create a low-scoring repo with a fresh evaluation
    sm.updateRepoScore('fresh/low', { closedWithoutMergeCount: 3, signals: {} });
    expect(sm.getLowScoringRepos(3)).toContain('fresh/low');

    // Manually backdate the lastEvaluatedAt to 31 days ago
    const state = sm.getState();
    const staleDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    state.repoScores['fresh/low'].lastEvaluatedAt = staleDate;

    // Stale score should be excluded — repo gets a chance to be re-evaluated
    expect(sm.getLowScoringRepos(3)).not.toContain('fresh/low');
  });

  it('should include repos with recent scores (<30 days) in low-scoring list', () => {
    const sm = new StateManager(false);
    sm.updateRepoScore('recent/low', { closedWithoutMergeCount: 3, signals: {} });

    // Backdate to 10 days ago (still within TTL)
    const state = sm.getState();
    const recentDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    state.repoScores['recent/low'].lastEvaluatedAt = recentDate;

    expect(sm.getLowScoringRepos(3)).toContain('recent/low');
  });
});

describe('getStats', () => {
  beforeEach(() => {
    mockTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-autopilot-test-'));
  });

  afterEach(() => {
    fs.rmSync(mockTmpDir, { recursive: true, force: true });
  });

  it('should compute aggregate statistics from repo scores', () => {
    const sm = new StateManager(false);
    sm.updateRepoScore('repo/a', { mergedPRCount: 3, closedWithoutMergeCount: 1, signals: {}, stargazersCount: 100 });
    sm.updateRepoScore('repo/b', { mergedPRCount: 2, closedWithoutMergeCount: 0, signals: {}, stargazersCount: 200 });

    const stats = sm.getStats();
    expect(stats.mergedPRs).toBe(5);
    expect(stats.closedPRs).toBe(1);
    expect(stats.totalTracked).toBe(2);
    expect(stats.mergeRate).toBe('83.3%');
  });

  it('should include repos from excludeRepos in stats (#591)', () => {
    const sm = new StateManager(false);
    sm.updateConfig({ excludeRepos: ['excluded/repo'] });
    sm.updateRepoScore('excluded/repo', {
      mergedPRCount: 10,
      closedWithoutMergeCount: 0,
      signals: {},
      stargazersCount: 100,
    });
    sm.updateRepoScore('included/repo', {
      mergedPRCount: 1,
      closedWithoutMergeCount: 0,
      signals: {},
      stargazersCount: 100,
    });

    const stats = sm.getStats();
    // excludeRepos only affects issue discovery, not stats
    expect(stats.mergedPRs).toBe(11);
    expect(stats.totalTracked).toBe(2);
  });

  it('should handle zero completed PRs (0% merge rate)', () => {
    const sm = new StateManager(false);
    const stats = sm.getStats();
    expect(stats.mergeRate).toBe('0.0%');
    expect(stats.mergedPRs).toBe(0);
    expect(stats.closedPRs).toBe(0);
  });
});

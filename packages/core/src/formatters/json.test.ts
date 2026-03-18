/**
 * Tests for JSON output formatter
 * Locks down the --json contract used by the plugin layer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  jsonSuccess,
  jsonError,
  outputJson,
  outputJsonError,
  toCompactDailyOutput,
  toCompactStartupOutput,
  type DailyOutput,
  type StartupOutput,
} from './json.js';

const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('jsonSuccess', () => {
  it('should wrap data with success envelope', () => {
    const result = jsonSuccess({ foo: 1 });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ foo: 1 });
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it('should include ISO 8601 timestamp', () => {
    const result = jsonSuccess('test');
    expect(result.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should not include error field', () => {
    const result = jsonSuccess({ foo: 1 });
    expect(result.error).toBeUndefined();
  });

  it('should handle null data', () => {
    const result = jsonSuccess(null);
    expect(result.success).toBe(true);
    expect(result.data).toBeNull();
  });

  it('should handle array data', () => {
    const result = jsonSuccess([1, 2, 3]);
    expect(result.success).toBe(true);
    expect(result.data).toEqual([1, 2, 3]);
  });
});

describe('jsonError', () => {
  it('should wrap error message with failure envelope', () => {
    const result = jsonError('boom');
    expect(result.success).toBe(false);
    expect(result.error).toBe('boom');
    expect(result.timestamp).toEqual(expect.any(String));
  });

  it('should not include data field', () => {
    const result = jsonError('boom');
    expect(result.data).toBeUndefined();
  });

  it('should include ISO 8601 timestamp', () => {
    const result = jsonError('boom');
    expect(result.timestamp).toMatch(ISO_8601_REGEX);
  });
});

describe('outputJson', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should write JSON success to stdout', () => {
    outputJson({ key: 'value' });
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.success).toBe(true);
    expect(output.data).toEqual({ key: 'value' });
    expect(output.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should output pretty-printed JSON', () => {
    outputJson({ key: 'value' });
    const raw = logSpy.mock.calls[0][0] as string;
    expect(raw).toContain('\n');
    expect(raw).toContain('  '); // 2-space indentation
  });
});

describe('outputJsonError', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it('should write JSON error to stdout', () => {
    outputJsonError('something broke');
    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    expect(output.success).toBe(false);
    expect(output.error).toBe('something broke');
    expect(output.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('should never put success inside data', () => {
    outputJson({ foo: 'bar' });
    const output = JSON.parse(logSpy.mock.calls[0][0]);
    // The contract: success lives at the envelope level, not inside data
    expect(output.data).toEqual({ foo: 'bar' });
    expect(output.data).not.toHaveProperty('success');
  });
});

// --- Compact output tests (#763) ---

function makeMockDailyOutput(): DailyOutput {
  return {
    digest: {
      generatedAt: '2026-03-17T00:00:00.000Z',
      openPRs: [],
      needsAddressingPRs: [],
      waitingOnMaintainerPRs: [],
      recentlyClosedPRs: [],
      recentlyMergedPRs: [],
      shelvedPRs: [],
      autoUnshelvedPRs: [],
      summary: { totalActivePRs: 5, totalMergedAllTime: 10, mergeRate: 80, totalNeedingAttention: 2 },
    },
    capacity: {
      hasCapacity: true,
      activePRCount: 5,
      maxActivePRs: 20,
      shelvedPRCount: 0,
      criticalIssueCount: 0,
      reason: 'You have capacity',
    },
    summary: 'This is a long markdown summary that takes up ~8KB...',
    briefSummary: '5 Active PRs | 2 need attention',
    actionableIssues: [
      {
        type: 'ci_failing',
        prUrl: 'https://github.com/org/repo/pull/1',
        label: '[CI Failing]',
        isNewContribution: false,
      },
    ],
    actionMenu: {
      items: [{ key: 'done', label: 'Done for now', description: 'End session' }],
      context: {
        hasActionableIssues: true,
        actionableCount: 1,
        hasCapacity: true,
        hasIssueResponses: false,
        issueResponseCount: 0,
      },
    },
    commentedIssues: [
      {
        repo: 'org/repo',
        number: 1,
        title: 'Issue',
        url: 'https://github.com/org/repo/issues/1',
        userLastCommentedAt: '2026-03-17T00:00:00Z',
        labels: [],
        daysSinceUserComment: 1,
        status: 'waiting',
      },
    ],
    repoGroups: [{ repo: 'org/repo', prUrls: ['https://github.com/org/repo/pull/1'] }],
    failures: [{ prUrl: 'https://github.com/org/repo/pull/2', error: 'timeout' }],
  };
}

describe('toCompactDailyOutput (#763)', () => {
  it('should retain essential fields', () => {
    const full = makeMockDailyOutput();
    const compact = toCompactDailyOutput(full);

    expect(compact.digest).toBe(full.digest);
    expect(compact.capacity).toBe(full.capacity);
    expect(compact.briefSummary).toBe(full.briefSummary);
    expect(compact.actionableIssues).toBe(full.actionableIssues);
    expect(compact.actionMenu).toBe(full.actionMenu);
    expect(compact.commentedIssues).toBe(full.commentedIssues);
  });

  it('should omit summary, repoGroups, failures', () => {
    const full = makeMockDailyOutput();
    const compact = toCompactDailyOutput(full);

    expect(compact).not.toHaveProperty('summary');
    expect(compact).not.toHaveProperty('repoGroups');
    expect(compact).not.toHaveProperty('failures');
  });

  it('should retain commentedIssues (used by review-issue-replies workflow)', () => {
    const full = makeMockDailyOutput();
    const compact = toCompactDailyOutput(full);

    expect(compact.commentedIssues).toEqual(full.commentedIssues);
    expect(compact.commentedIssues).toHaveLength(1);
  });

  it('should include failureCount from failures array length', () => {
    const full = makeMockDailyOutput();
    const compact = toCompactDailyOutput(full);

    expect(compact.failureCount).toBe(1); // mock has 1 failure entry
    expect(compact).not.toHaveProperty('failures');
  });

  it('should report failureCount 0 when no failures', () => {
    const full = makeMockDailyOutput();
    full.failures = [];
    const compact = toCompactDailyOutput(full);

    expect(compact.failureCount).toBe(0);
  });

  it('should produce smaller JSON output than the full version', () => {
    const full = makeMockDailyOutput();
    const compact = toCompactDailyOutput(full);

    const fullSize = JSON.stringify(full).length;
    const compactSize = JSON.stringify(compact).length;

    expect(compactSize).toBeLessThan(fullSize);
  });
});

describe('toCompactStartupOutput (#763)', () => {
  it('should retain all non-daily fields', () => {
    const full: StartupOutput = {
      version: '1.0.0',
      setupComplete: true,
      autoDetected: true,
      daily: makeMockDailyOutput(),
      dashboardUrl: 'http://localhost:3000',
      issueList: { path: 'issues.md', source: 'configured', availableCount: 5, completedCount: 3 },
    };
    const compact = toCompactStartupOutput(full);

    expect(compact.version).toBe('1.0.0');
    expect(compact.setupComplete).toBe(true);
    expect(compact.autoDetected).toBe(true);
    expect(compact.dashboardUrl).toBe('http://localhost:3000');
    expect(compact.issueList).toBe(full.issueList);
  });

  it('should compact the daily field', () => {
    const full: StartupOutput = {
      version: '1.0.0',
      setupComplete: true,
      daily: makeMockDailyOutput(),
    };
    const compact = toCompactStartupOutput(full);

    // Daily should be compact (no summary, repoGroups, failures)
    expect(compact.daily).toBeDefined();
    expect(compact.daily).not.toHaveProperty('summary');
    expect(compact.daily).not.toHaveProperty('repoGroups');
    expect(compact.daily).not.toHaveProperty('failures');
    expect(compact.daily!.briefSummary).toBe(full.daily!.briefSummary);
    // commentedIssues should be retained
    expect(compact.daily!.commentedIssues).toBe(full.daily!.commentedIssues);
  });

  it('should handle missing daily field', () => {
    const full: StartupOutput = {
      version: '1.0.0',
      setupComplete: false,
    };
    const compact = toCompactStartupOutput(full);

    expect(compact.daily).toBeUndefined();
  });

  it('should handle auth error shape', () => {
    const full: StartupOutput = {
      version: '1.0.0',
      setupComplete: true,
      authError: 'No token',
    };
    const compact = toCompactStartupOutput(full);

    expect(compact.authError).toBe('No token');
    expect(compact.daily).toBeUndefined();
  });
});

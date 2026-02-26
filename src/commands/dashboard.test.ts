/**
 * Tests for dashboard.ts core helper functions
 */

import { describe, it, expect, vi } from 'vitest';

// Mock all external dependencies so the module loads without side effects.
// dashboard.ts imports from core/index.js (which initialises Octokit and reads
// state files at import time) and from fs / child_process.  We only need the
// pure helper functions here, so a lightweight mock is sufficient.
vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
  getDashboardPath: vi.fn(),
  PRMonitor: vi.fn(),
  IssueConversationMonitor: vi.fn(),
  getGitHubToken: vi.fn(),
}));

vi.mock('../formatters/json.js', () => ({
  outputJson: vi.fn(),
}));

vi.mock('fs', () => ({
  default: {
    writeFileSync: vi.fn(),
    chmodSync: vi.fn(),
  },
  writeFileSync: vi.fn(),
  chmodSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import { escapeHtml, buildDashboardStats } from './dashboard.js';
import type { DailyDigest, AgentState, FetchedPR } from '../core/types.js';

// ─── Minimal fixture factories ─────────────────────────────────────────────────

function makeMinimalConfig(): AgentState['config'] {
  return {
    setupComplete: false,
    maxActivePRs: 10,
    dormantThresholdDays: 30,
    approachingDormantDays: 25,
    maxIssueAgeDays: 90,
    languages: [],
    labels: [],
    excludeRepos: [],
    trustedProjects: [],
    githubUsername: 'testuser',
    minRepoScoreThreshold: 4,
    starredRepos: [],
    shelvedPRUrls: [],
    dismissedIssues: {},
    snoozedPRs: {},
  };
}

function makeMinimalState(overrides: Partial<AgentState> = {}): AgentState {
  return {
    version: 2,
    repoScores: {},
    config: makeMinimalConfig(),
    events: [],
    lastRunAt: '2026-01-01T00:00:00Z',
    activePRs: [],
    activeIssues: [],
    dormantPRs: [],
    mergedPRs: [],
    closedPRs: [],
    ...overrides,
  };
}

function makeMinimalFetchedPR(overrides: Partial<FetchedPR> = {}): FetchedPR {
  return {
    id: 1,
    url: 'https://github.com/owner/repo/pull/1',
    repo: 'owner/repo',
    number: 1,
    title: 'Test PR',
    status: 'dormant',
    displayLabel: '[Dormant]',
    displayDescription: 'No activity for 30+ days',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    daysSinceActivity: 30,
    ciStatus: 'unknown',
    failingCheckNames: [],
    classifiedChecks: [],
    hasMergeConflict: false,
    reviewDecision: 'unknown',
    hasUnrespondedComment: false,
    hasIncompleteChecklist: false,
    maintainerActionHints: [],
    ...overrides,
  };
}

function makeMinimalDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: '2026-01-15T12:00:00Z',
    openPRs: [],
    prsNeedingResponse: [],
    ciFailingPRs: [],
    ciBlockedPRs: [],
    ciNotRunningPRs: [],
    mergeConflictPRs: [],
    needsRebasePRs: [],
    missingRequiredFilesPRs: [],
    incompleteChecklistPRs: [],
    needsChangesPRs: [],
    changesAddressedPRs: [],
    waitingOnMaintainerPRs: [],
    approachingDormant: [],
    dormantPRs: [],
    healthyPRs: [],
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

function makeRepoScore(
  mergedPRCount: number,
  closedWithoutMergeCount: number,
): AgentState['repoScores'][string] {
  return {
    repo: 'owner/repo',
    score: 7,
    mergedPRCount,
    closedWithoutMergeCount,
    avgResponseDays: null,
    lastEvaluatedAt: '2026-01-01T00:00:00Z',
    signals: {
      hasActiveMaintainers: true,
      isResponsive: true,
      hasHostileComments: false,
    },
  };
}

// ─── escapeHtml ────────────────────────────────────────────────────────────────

describe('escapeHtml', () => {
  it('should return an empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should return plain text unchanged', () => {
    expect(escapeHtml('Hello world')).toBe('Hello world');
  });

  it('should escape ampersands', () => {
    expect(escapeHtml('foo & bar')).toBe('foo &amp; bar');
  });

  it('should escape less-than signs', () => {
    expect(escapeHtml('1 < 2')).toBe('1 &lt; 2');
  });

  it('should escape greater-than signs', () => {
    expect(escapeHtml('2 > 1')).toBe('2 &gt; 1');
  });

  it('should escape double quotes', () => {
    expect(escapeHtml('say "hello"')).toBe('say &quot;hello&quot;');
  });

  it('should escape single quotes', () => {
    expect(escapeHtml("it's here")).toBe('it&#39;s here');
  });

  it('should escape all five special characters together', () => {
    expect(escapeHtml('<"\'>&')).toBe('&lt;&quot;&#39;&gt;&amp;');
  });

  it('should prevent a basic script-injection string from being injected verbatim', () => {
    const xss = '<script>alert("xss")</script>';
    const escaped = escapeHtml(xss);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('should escape PR titles with special HTML characters', () => {
    const title = 'fix: handle foo<T> && bar > 0';
    const escaped = escapeHtml(title);
    expect(escaped).toBe('fix: handle foo&lt;T&gt; &amp;&amp; bar &gt; 0');
  });

  it('should escape multiple ampersands', () => {
    expect(escapeHtml('a & b & c')).toBe('a &amp; b &amp; c');
  });

  it('should not special-case already entity-encoded text — ampersands in entities are re-escaped', () => {
    // escapeHtml is a pure string escaper, not an HTML-aware parser.
    // "&amp;" contains "&", which will be escaped again to "&amp;amp;".
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });

  it('should escape an on* event attribute injection attempt', () => {
    const payload = '" onmouseover="alert(1)';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('"');
    expect(escaped).toBe('&quot; onmouseover=&quot;alert(1)');
  });
});

// ─── buildDashboardStats ───────────────────────────────────────────────────────

describe('buildDashboardStats', () => {
  it('should return zero stats when digest and state are empty', () => {
    const digest = makeMinimalDigest();
    const state = makeMinimalState();

    const stats = buildDashboardStats(digest, state);

    expect(stats.activePRs).toBe(0);
    expect(stats.shelvedPRs).toBe(0);
    expect(stats.mergedPRs).toBe(0);
    expect(stats.closedPRs).toBe(0);
    expect(stats.mergeRate).toBe('0.0%');
  });

  it('should reflect totalActivePRs from digest summary', () => {
    const digest = makeMinimalDigest({
      summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 0, mergeRate: 0 },
    });
    const state = makeMinimalState();

    const stats = buildDashboardStats(digest, state);

    expect(stats.activePRs).toBe(5);
  });

  it('should count shelvedPRs from digest.shelvedPRs array length', () => {
    const shelvedPR1 = makeMinimalFetchedPR({ number: 1, url: 'https://github.com/owner/repo/pull/1' });
    const shelvedPR2 = makeMinimalFetchedPR({ number: 2, url: 'https://github.com/owner/repo/pull/2' });
    const digest = makeMinimalDigest({ shelvedPRs: [shelvedPR1, shelvedPR2] });
    const state = makeMinimalState();

    const stats = buildDashboardStats(digest, state);

    expect(stats.shelvedPRs).toBe(2);
  });

  it('should reflect totalMergedAllTime from digest summary', () => {
    const digest = makeMinimalDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 42, mergeRate: 85.0 },
    });
    const state = makeMinimalState();

    const stats = buildDashboardStats(digest, state);

    expect(stats.mergedPRs).toBe(42);
  });

  it('should sum closedWithoutMergeCount across all repoScores', () => {
    const state = makeMinimalState({
      repoScores: {
        'owner/repo-a': makeRepoScore(5, 2),
        'owner/repo-b': makeRepoScore(3, 1),
        'owner/repo-c': makeRepoScore(10, 0),
      },
    });
    const digest = makeMinimalDigest();

    const stats = buildDashboardStats(digest, state);

    expect(stats.closedPRs).toBe(3); // 2 + 1 + 0
  });

  it('should format mergeRate as a percentage string with one decimal place', () => {
    const digest = makeMinimalDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 10, mergeRate: 76.6666 },
    });
    const state = makeMinimalState();

    const stats = buildDashboardStats(digest, state);

    expect(stats.mergeRate).toBe('76.7%');
  });

  it('should handle mergeRate of 100%', () => {
    const digest = makeMinimalDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 5, mergeRate: 100 },
    });

    const stats = buildDashboardStats(digest, makeMinimalState());

    expect(stats.mergeRate).toBe('100.0%');
  });

  it('should handle a state with no repoScores gracefully', () => {
    const state = makeMinimalState({ repoScores: undefined as unknown as AgentState['repoScores'] });
    const digest = makeMinimalDigest();

    expect(() => buildDashboardStats(digest, state)).not.toThrow();
    const stats = buildDashboardStats(digest, state);
    expect(stats.closedPRs).toBe(0);
  });

  it('should handle empty shelvedPRs array', () => {
    const digest = makeMinimalDigest({ shelvedPRs: [] });
    const stats = buildDashboardStats(digest, makeMinimalState());
    expect(stats.shelvedPRs).toBe(0);
  });

  it('should return zero closedPRs when all repos have zero closed counts', () => {
    const state = makeMinimalState({
      repoScores: {
        'owner/repo-a': makeRepoScore(10, 0),
        'owner/repo-b': makeRepoScore(5, 0),
      },
    });

    const stats = buildDashboardStats(makeMinimalDigest(), state);

    expect(stats.closedPRs).toBe(0);
  });

  it('should handle a full realistic scenario', () => {
    const shelvedPR = makeMinimalFetchedPR();
    const digest = makeMinimalDigest({
      summary: { totalActivePRs: 3, totalNeedingAttention: 1, totalMergedAllTime: 20, mergeRate: 80.0 },
      shelvedPRs: [shelvedPR],
    });
    const state = makeMinimalState({
      repoScores: {
        'owner/repo-a': makeRepoScore(15, 3),
        'owner/repo-b': makeRepoScore(5, 2),
      },
    });

    const stats = buildDashboardStats(digest, state);

    expect(stats.activePRs).toBe(3);
    expect(stats.shelvedPRs).toBe(1);
    expect(stats.mergedPRs).toBe(20);
    expect(stats.closedPRs).toBe(5); // 3 + 2
    expect(stats.mergeRate).toBe('80.0%');
  });
});

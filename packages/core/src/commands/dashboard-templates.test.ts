import { describe, it, expect } from 'vitest';
import { escapeHtml, buildDashboardStats, generateDashboardHtml, type DashboardStats } from './dashboard-templates.js';
import type {
  DailyDigest,
  AgentState,
  CommentedIssueWithResponse,
  ShelvedPRRef,
  MergedPR,
  ClosedPR,
} from '../core/types.js';
import { makeFetchedPR, makeDailyDigest as makeDigest, makeAgentState } from '../core/test-utils.js';

// ---------------------------------------------------------------------------
// Factories — thin wrappers over shared factories with file-specific defaults
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<AgentState> = {}): AgentState {
  return makeAgentState({
    config: {
      setupComplete: true,
      maxActivePRs: 5,
      dormantThresholdDays: 30,
      approachingDormantDays: 25,
      maxIssueAgeDays: 90,
      languages: ['typescript'],
      labels: ['good first issue'],
      excludeRepos: [],
      trustedProjects: [],
      githubUsername: 'testuser',
      minRepoScoreThreshold: 4,
      starredRepos: [],
    },
    ...overrides,
  });
}

function makeStats(overrides: Partial<DashboardStats> = {}): DashboardStats {
  return {
    activePRs: 0,
    shelvedPRs: 0,
    mergedPRs: 0,
    closedPRs: 0,
    mergeRate: '0.0%',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });

  it('escapes double quotes', () => {
    expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;');
  });

  it('escapes single quotes', () => {
    expect(escapeHtml("it's")).toBe('it&#39;s');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('does not alter safe strings', () => {
    const safe = 'Hello World 123';
    expect(escapeHtml(safe)).toBe(safe);
  });

  it('escapes all special characters in a single string', () => {
    expect(escapeHtml('<div class="a" data=\'b\'>&</div>')).toBe(
      '&lt;div class=&quot;a&quot; data=&#39;b&#39;&gt;&amp;&lt;/div&gt;',
    );
  });

  it('handles multiple consecutive ampersands', () => {
    expect(escapeHtml('&&&&')).toBe('&amp;&amp;&amp;&amp;');
  });

  it('escapes pre-existing HTML entities (does not skip already-escaped content)', () => {
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// buildDashboardStats
// ---------------------------------------------------------------------------

describe('buildDashboardStats', () => {
  it('returns zeros when digest has no summary', () => {
    const digest = makeDigest();
    // Remove summary to trigger the default fallback
    (digest as any).summary = undefined;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats).toEqual({
      activePRs: 0,
      shelvedPRs: 0,
      mergedPRs: 0,
      closedPRs: 0,
      mergeRate: '0.0%',
    });
  });

  it('pulls activePRs from summary.totalActivePRs', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 5, totalNeedingAttention: 2, totalMergedAllTime: 10, mergeRate: 80 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.activePRs).toBe(5);
  });

  it('counts shelvedPRs from digest.shelvedPRs array length', () => {
    const shelvedPRs: ShelvedPRRef[] = [
      { number: 1, url: 'u1', title: 't1', repo: 'r/1', daysSinceActivity: 5, status: 'healthy' },
      { number: 2, url: 'u2', title: 't2', repo: 'r/2', daysSinceActivity: 10, status: 'dormant' },
    ];
    const digest = makeDigest({ shelvedPRs });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.shelvedPRs).toBe(2);
  });

  it('pulls mergedPRs from summary.totalMergedAllTime', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 42, mergeRate: 85 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergedPRs).toBe(42);
  });

  it('sums closedWithoutMergeCount across all repoScores', () => {
    const state = makeState({
      repoScores: {
        'a/b': {
          repo: 'a/b',
          score: 5,
          mergedPRCount: 1,
          closedWithoutMergeCount: 3,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
        'c/d': {
          repo: 'c/d',
          score: 7,
          mergedPRCount: 2,
          closedWithoutMergeCount: 1,
          avgResponseDays: null,
          lastEvaluatedAt: '2025-06-01T00:00:00Z',
          signals: { hasActiveMaintainers: true, isResponsive: true, hasHostileComments: false },
        },
      },
    });
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(4); // 3 + 1
  });

  it('formats mergeRate as a percentage string', () => {
    const digest = makeDigest({
      summary: { totalActivePRs: 0, totalNeedingAttention: 0, totalMergedAllTime: 0, mergeRate: 72.3456 },
    });
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergeRate).toBe('72.3%');
  });

  it('handles null/undefined mergeRate gracefully', () => {
    const digest = makeDigest();
    (digest.summary as any).mergeRate = null;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.mergeRate).toBe('0.0%');
  });

  it('handles missing repoScores gracefully', () => {
    const state = makeState();
    (state as any).repoScores = undefined;
    const stats = buildDashboardStats(makeDigest(), state);
    expect(stats.closedPRs).toBe(0);
  });

  it('handles missing shelvedPRs array', () => {
    const digest = makeDigest();
    (digest as any).shelvedPRs = undefined;
    const stats = buildDashboardStats(digest, makeState());
    expect(stats.shelvedPRs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// generateDashboardHtml
// ---------------------------------------------------------------------------

describe('generateDashboardHtml', () => {
  /** Shorthand that defaults every argument so tests only supply what they care about. */
  function renderHtml(
    options: {
      stats?: DashboardStats;
      monthly?: Record<string, number>;
      monthlyClosed?: Record<string, number>;
      monthlyOpened?: Record<string, number>;
      digest?: DailyDigest;
      state?: AgentState;
      issueResponses?: CommentedIssueWithResponse[];
    } = {},
  ): string {
    return generateDashboardHtml(
      options.stats ?? makeStats(),
      options.monthly ?? {},
      options.monthlyClosed ?? {},
      options.monthlyOpened ?? {},
      options.digest ?? makeDigest(),
      options.state ?? makeState(),
      options.issueResponses,
    );
  }

  it('returns a complete HTML document', () => {
    const html = renderHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('<title>OSS Autopilot - Mission Control</title>');
  });

  it('includes Chart.js script tag', () => {
    const html = renderHtml();
    expect(html).toContain('cdn.jsdelivr.net/npm/chart.js');
  });

  it('renders stat cards with provided values', () => {
    const stats = makeStats({ activePRs: 5, mergedPRs: 42, mergeRate: '85.0%' });
    const html = renderHtml({ stats });
    // Assert against the exact stat-value div structure to avoid matching CSS/SVG noise
    expect(html).toContain('<div class="stat-value">5</div>');
    expect(html).toContain('<div class="stat-value">42</div>');
    expect(html).toContain('<div class="stat-value">85.0%</div>');
  });

  it('escapes PR titles in output to prevent XSS', () => {
    const xssPR = makeFetchedPR({
      title: '<img src=x onerror=alert(1)>',
      repo: 'evil/repo',
      url: 'https://github.com/evil/repo/pull/1',
    });
    const digest = makeDigest({ openPRs: [xssPR], healthyPRs: [xssPR] });
    const html = renderHtml({ digest });
    // The raw XSS payload must NOT appear in the HTML
    expect(html).not.toContain('<img src=x onerror=alert(1)>');
    // The escaped version should be present
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('escapes repo names in data attributes', () => {
    const pr = makeFetchedPR({ repo: 'owner/<script>', title: 'normal title' });
    const digest = makeDigest({ openPRs: [pr], healthyPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).not.toContain('data-repo="owner/<script>"');
    expect(html).toContain('owner/&lt;script&gt;');
  });

  it('renders action-required PRs when present', () => {
    const pr = makeFetchedPR({
      title: 'Fix authentication',
      status: 'needs_response',
      hasUnrespondedComment: true,
    });
    const digest = makeDigest({ openPRs: [pr], prsNeedingResponse: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('needs-response');
    expect(html).toContain('Needs Response');
  });

  it('renders CI failing PRs', () => {
    const pr = makeFetchedPR({ status: 'failing_ci', ciStatus: 'failing' });
    const digest = makeDigest({ openPRs: [pr], ciFailingPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('ci-failing');
    expect(html).toContain('CI Failing');
  });

  it('renders merge conflict PRs', () => {
    const pr = makeFetchedPR({ status: 'merge_conflict', hasMergeConflict: true });
    const digest = makeDigest({ openPRs: [pr], mergeConflictPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('class="health-item conflict"');
    expect(html).toContain('Merge Conflict');
  });

  it('renders shelved PRs section', () => {
    const shelved: ShelvedPRRef = {
      number: 99,
      url: 'https://github.com/o/r/pull/99',
      title: 'Shelved PR title',
      repo: 'o/r',
      daysSinceActivity: 40,
      status: 'dormant',
    };
    const digest = makeDigest({ shelvedPRs: [shelved] });
    const html = renderHtml({ digest });
    expect(html).toContain('Shelved PR title');
    expect(html).toContain('o/r#99');
  });

  it('renders recently merged PRs', () => {
    const merged: MergedPR = {
      url: 'https://github.com/a/b/pull/10',
      repo: 'a/b',
      number: 10,
      title: 'Add feature',
      mergedAt: '2025-06-18T00:00:00Z',
    };
    const digest = makeDigest({ recentlyMergedPRs: [merged] });
    const html = renderHtml({ digest });
    expect(html).toContain('a/b#10');
    expect(html).toContain('Merged');
    expect(html).toContain('Add feature');
  });

  it('renders recently closed PRs', () => {
    const closed: ClosedPR = {
      url: 'https://github.com/x/y/pull/5',
      repo: 'x/y',
      number: 5,
      title: 'Closed PR',
      closedAt: '2025-06-19T00:00:00Z',
    };
    const digest = makeDigest({ recentlyClosedPRs: [closed] });
    const html = renderHtml({ digest });
    expect(html).toContain('x/y#5');
    expect(html).toContain('Closed');
  });

  it('renders waiting-on-maintainer PRs', () => {
    const pr = makeFetchedPR({ status: 'waiting_on_maintainer' });
    const digest = makeDigest({ openPRs: [pr], waitingOnMaintainerPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('waiting-maintainer');
    expect(html).toContain('Waiting on Maintainer');
  });

  it('renders needs-changes PRs', () => {
    const pr = makeFetchedPR({ status: 'needs_changes', reviewDecision: 'changes_requested' });
    const digest = makeDigest({ openPRs: [pr], needsChangesPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('needs-changes');
    expect(html).toContain('Needs Changes');
  });

  it('renders issue responses section when present', () => {
    const issueResponse: CommentedIssueWithResponse = {
      url: 'https://github.com/org/proj/issues/100',
      repo: 'org/proj',
      number: 100,
      title: 'Issue with response',
      status: 'new_response',
      userLastCommentedAt: '2025-06-10T00:00:00Z',
      labels: [],
      daysSinceUserComment: 5,
      lastResponseAuthor: 'maintainer1',
      lastResponseBody: 'Go ahead, looks good!',
      lastResponseAt: '2025-06-15T00:00:00Z',
      isFromMaintainer: true,
    };
    const html = renderHtml({ issueResponses: [issueResponse] });
    expect(html).toContain('org/proj#100');
    expect(html).toContain('@maintainer1');
    expect(html).toContain('Go ahead, looks good!');
  });

  it('escapes issue response content to prevent XSS', () => {
    const issueResponse: CommentedIssueWithResponse = {
      url: 'https://github.com/o/r/issues/200',
      repo: 'o/r',
      number: 200,
      title: '<script>alert("xss")</script>',
      status: 'new_response',
      userLastCommentedAt: '2025-06-10T00:00:00Z',
      labels: [],
      daysSinceUserComment: 3,
      lastResponseAuthor: '<img onerror=alert(1)>',
      lastResponseBody: 'safe text',
      lastResponseAt: '2025-06-15T00:00:00Z',
      isFromMaintainer: false,
    };
    const html = renderHtml({ issueResponses: [issueResponse] });
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).not.toContain('<img onerror=alert(1)>');
    // Positive assertions: escaped versions must be present (prevents false pass if section fails to render)
    expect(html).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(html).toContain('&lt;img onerror=alert(1)&gt;');
  });

  it('renders monthly chart data when provided', () => {
    const monthly = { '2025-04': 2, '2025-05': 5, '2025-06': 3 };
    const html = renderHtml({ monthly });
    // Chart data should be embedded in the HTML
    expect(html).toContain('2025-04');
    expect(html).toContain('2025-05');
    expect(html).toContain('2025-06');
  });

  it('filters shelved PRs out of active PR list', () => {
    const pr1 = makeFetchedPR({ url: 'https://github.com/o/r/pull/1', number: 1, title: 'Active PR' });
    const pr2 = makeFetchedPR({ url: 'https://github.com/o/r/pull/2', number: 2, title: 'Shelved PR' });
    const shelved: ShelvedPRRef = {
      number: 2,
      url: 'https://github.com/o/r/pull/2',
      title: 'Shelved PR',
      repo: 'owner/repo',
      daysSinceActivity: 40,
      status: 'dormant',
    };
    const digest = makeDigest({ openPRs: [pr1, pr2], shelvedPRs: [shelved] });
    const html = renderHtml({ digest });
    // Active section should show 1 open (pr2 filtered out), shelved section gets pr2
    expect(html).toContain('<span class="pr-count">1 open</span>');
    expect(html).toContain('Active PR');
  });

  it('truncates long titles with ellipsis in health items', () => {
    const longTitle = 'A'.repeat(60);
    const pr = makeFetchedPR({ title: longTitle, status: 'failing_ci', ciStatus: 'failing' });
    // ciFailingPRs uses titleMeta which calls truncateTitle (max 50)
    const digest = makeDigest({ openPRs: [pr], ciFailingPRs: [pr] });
    const html = renderHtml({ digest });
    // The truncated version (50 chars + "...") should appear in the health meta
    expect(html).toContain('A'.repeat(50) + '...');
  });

  it('handles completely empty digest gracefully', () => {
    const html = renderHtml();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('</html>');
    // Verify dashboard skeleton renders with zero values and empty state
    expect(html).toContain('<div class="stat-value">0</div>');
    expect(html).toContain('No active pull requests');
  });

  it('renders maintainer comment in needs-response PRs', () => {
    const pr = makeFetchedPR({
      status: 'needs_response',
      hasUnrespondedComment: true,
      lastMaintainerComment: {
        author: 'maint-user',
        body: 'Please address the review comments',
        createdAt: '2025-06-14T00:00:00Z',
      },
    });
    const digest = makeDigest({ openPRs: [pr], prsNeedingResponse: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('@maint-user');
    expect(html).toContain('Please address the review comment');
  });

  it('renders missing required files info', () => {
    const pr = makeFetchedPR({
      status: 'missing_required_files',
      missingRequiredFiles: ['changeset', 'CLA'],
    });
    const digest = makeDigest({ openPRs: [pr], missingRequiredFilesPRs: [pr] });
    const html = renderHtml({ digest });
    expect(html).toContain('changeset');
    expect(html).toContain('CLA');
  });

  it('renders auto-unshelved PRs', () => {
    const unshelved: ShelvedPRRef = {
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      title: 'Auto-unshelved',
      repo: 'o/r',
      daysSinceActivity: 1,
      status: 'needs_response',
    };
    const digest = makeDigest({ autoUnshelvedPRs: [unshelved] });
    const html = renderHtml({ digest });
    expect(html).toContain('Auto-unshelved');
    expect(html).toContain('o/r#7');
  });
});

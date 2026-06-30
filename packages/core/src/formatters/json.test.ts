/**
 * Tests for JSON output formatter
 * Locks down the --json contract used by the plugin layer
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  jsonSuccess,
  setEnvelopeGistWarning,
  jsonError,
  outputJson,
  outputJsonError,
  formatJson,
  outputJsonValidated,
  StatusOutputSchema,
  DailyOutputSchema,
  CompactDailyOutputSchema,
  SearchOutputSchema,
  DoctorOutputSchema,
  SkipAddOutputSchema,
  ListMoveTierOutputSchema,
  ListMarkDoneOutputSchema,
  PostOutputSchema,
  ClaimOutputSchema,
  InitOutputSchema,
  CheckSetupOutputSchema,
  SetupOutputSchema,
  ConfigCommandOutputSchema,
  MoveOutputSchema,
  PRTemplateOutputSchema,
  ParseIssueListOutputSchema,
  CheckIntegrationOutputSchema,
  DetectFormattersOutputSchema,
  LocalReposOutputSchema,
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

  it('should include errorCode when provided', () => {
    const result = jsonError('Auth failed', 'AUTH_REQUIRED');
    expect(result.success).toBe(false);
    expect(result.error).toBe('Auth failed');
    expect(result.errorCode).toBe('AUTH_REQUIRED');
  });

  it('should omit errorCode when not provided', () => {
    const result = jsonError('Something broke');
    expect(result.errorCode).toBeUndefined();
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
    attention: { needsAttention: 2, stuckCI: 1, dormantFollowup: 0, waiting: 2 },
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
        userLastCommentBody: '',
        labels: [],
        daysSinceUserComment: 1,
        status: 'waiting',
      },
    ],
    repoGroups: [{ repo: 'org/repo', prUrls: ['https://github.com/org/repo/pull/1'] }],
    failures: [{ prUrl: 'https://github.com/org/repo/pull/2', error: 'timeout' }],
    warnings: [],
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

describe('formatJson (#1105)', () => {
  const SmallSchema = z.object({
    name: z.string(),
    count: z.number().int().nonnegative(),
  });

  it('wraps schema-conformant data in the standard envelope', () => {
    const out = formatJson(SmallSchema, { name: 'foo', count: 3 });
    expect(out.success).toBe(true);
    expect(out.data).toEqual({ name: 'foo', count: 3 });
    expect(out.timestamp).toMatch(ISO_8601_REGEX);
  });

  it('throws a contract-drift error with field paths on mismatch', () => {
    expect(() => formatJson(SmallSchema, { name: 'foo', count: -1 })).toThrow(/contract drift.*count/i);
    expect(() => formatJson(SmallSchema, { name: 'foo' })).toThrow(/contract drift.*count/i);
    expect(() => formatJson(SmallSchema, { name: 42, count: 0 })).toThrow(/contract drift.*name/i);
  });

  it('rejects extra fields by default? (Zod default is to strip unless strict)', () => {
    // The default Zod object schema strips unknown keys rather than rejecting,
    // so this passes through validation. Surface that explicitly so a future
    // contributor doesn't expect strict behavior accidentally.
    const out = formatJson(SmallSchema, { name: 'foo', count: 3, extra: 'ignored' });
    expect(out.data).toEqual({ name: 'foo', count: 3 });
  });

  it('validates real StatusOutputSchema-conformant data round-trip', () => {
    const data = {
      stats: {
        mergedPRs: 5,
        closedPRs: 1,
        activeIssues: 2,
        trustedProjects: 4,
        mergeRate: '83%',
        needsResponse: 1,
      },
      lastRunAt: '2026-04-25T00:00:00.000Z',
    };
    const out = formatJson(StatusOutputSchema, data);
    expect(out.success).toBe(true);
    expect(out.data).toMatchObject(data);
  });

  it('rejects StatusOutputSchema input where stats.mergeRate is the wrong type', () => {
    const data = {
      stats: {
        mergedPRs: 5,
        closedPRs: 1,
        activeIssues: 2,
        trustedProjects: 4,
        mergeRate: 0.83, // should be string per the schema
        needsResponse: 1,
      },
      lastRunAt: '2026-04-25T00:00:00.000Z',
    };
    expect(() => formatJson(StatusOutputSchema, data)).toThrow(/contract drift.*stats\.mergerate/i);
  });
});

describe('outputJsonValidated (#1105)', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('prints the validated envelope to stdout', () => {
    const Schema = z.object({ ok: z.literal(true) });
    outputJsonValidated(Schema, { ok: true });
    const printed = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(printed);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({ ok: true });
  });

  it('throws on contract drift before printing', () => {
    const Schema = z.object({ ok: z.literal(true) });
    expect(() => outputJsonValidated(Schema, { ok: false })).toThrow(/contract drift/i);
    expect(consoleSpy).not.toHaveBeenCalled();
  });
});

describe('DailyOutputSchema (#1146)', () => {
  it('round-trips a fully populated DailyOutput from the fixture', () => {
    const fixture = makeMockDailyOutput();
    const out = formatJson(DailyOutputSchema, fixture);
    expect(out.success).toBe(true);
  });

  it('rejects drift: missing top-level field', () => {
    const fixture = makeMockDailyOutput();
    const broken = { ...fixture, summary: undefined } as unknown;
    expect(() => formatJson(DailyOutputSchema, broken)).toThrow(/contract drift.*summary/i);
  });

  it('rejects drift: needsAddressingPRs not a string array', () => {
    const fixture = makeMockDailyOutput();
    const broken = {
      ...fixture,
      digest: { ...fixture.digest, needsAddressingPRs: [{ url: 'x' }] },
    };
    expect(() => formatJson(DailyOutputSchema, broken)).toThrow(/contract drift.*needsaddressingprs/i);
  });

  it('rejects drift: actionMenu missing context flag', () => {
    const fixture = makeMockDailyOutput();
    const broken = {
      ...fixture,
      actionMenu: {
        items: fixture.actionMenu.items,
        context: {
          hasActionableIssues: true,
          actionableCount: 1,
          hasCapacity: true,
          // hasIssueResponses removed
          issueResponseCount: 0,
        },
      },
    } as unknown;
    expect(() => formatJson(DailyOutputSchema, broken)).toThrow(/contract drift.*hasissueresponses/i);
  });
});

describe('CompactDailyOutputSchema (#1146)', () => {
  it('round-trips toCompactDailyOutput(fixture)', () => {
    const compact = toCompactDailyOutput(makeMockDailyOutput());
    const out = formatJson(CompactDailyOutputSchema, compact);
    expect(out.success).toBe(true);
  });

  it('rejects drift: failureCount as a string', () => {
    const compact = toCompactDailyOutput(makeMockDailyOutput());
    const broken = { ...compact, failureCount: '0' } as unknown;
    expect(() => formatJson(CompactDailyOutputSchema, broken)).toThrow(/contract drift.*failurecount/i);
  });
});

describe('SearchOutputSchema (#1147)', () => {
  function makeSearchCandidate() {
    return {
      issue: {
        repo: 'foo/bar',
        repoUrl: 'https://github.com/foo/bar',
        number: 42,
        title: 'fix the thing',
        url: 'https://github.com/foo/bar/issues/42',
        labels: ['good first issue'],
      },
      recommendation: 'approve' as const,
      reasonsToApprove: ['active maintainer'],
      reasonsToSkip: [],
      searchPriority: 'starred' as const,
      viabilityScore: 88,
      grade: { score: 10, reason: 'fast merges' },
      repoScore: {
        score: 9.2,
        mergedPRCount: 3,
        closedWithoutMergeCount: 0,
        isResponsive: true,
        lastMergedAt: '2026-04-01T00:00:00Z',
      },
    };
  }

  it('round-trips a fully populated candidate', () => {
    const data = {
      candidates: [makeSearchCandidate()],
      excludedRepos: ['stale/abandoned'],
      aiPolicyBlocklist: ['anti-ai/repo'],
      hiddenOwnPRCount: 1,
    };
    expect(formatJson(SearchOutputSchema, data).success).toBe(true);
  });

  it('round-trips an empty result', () => {
    const data = { candidates: [], excludedRepos: [], aiPolicyBlocklist: [], hiddenOwnPRCount: 0 };
    expect(formatJson(SearchOutputSchema, data).success).toBe(true);
  });

  it('rejects drift: out-of-range grade score', () => {
    const candidate = makeSearchCandidate();
    (candidate.grade as { score: number; reason: string }).score = 0;
    const data = { candidates: [candidate], excludedRepos: [], aiPolicyBlocklist: [] };
    expect(() => formatJson(SearchOutputSchema, data)).toThrow(/contract drift.*score/i);
  });

  it('rejects drift: missing reasonsToApprove', () => {
    const candidate = makeSearchCandidate() as unknown as Record<string, unknown>;
    delete candidate.reasonsToApprove;
    const data = { candidates: [candidate], excludedRepos: [], aiPolicyBlocklist: [] };
    expect(() => formatJson(SearchOutputSchema, data)).toThrow(/contract drift.*reasonstoapprove/i);
  });

  it('accepts a candidate without optional repoScore', () => {
    const candidate = makeSearchCandidate() as unknown as Record<string, unknown>;
    delete candidate.repoScore;
    const data = { candidates: [candidate], excludedRepos: [], aiPolicyBlocklist: [], hiddenOwnPRCount: 0 };
    expect(formatJson(SearchOutputSchema, data).success).toBe(true);
  });
});

describe('DoctorOutputSchema (#1148)', () => {
  it('round-trips a typical multi-check report', () => {
    const data = {
      checks: [
        { name: 'github-token', status: 'ok' as const, message: 'token resolved' },
        {
          name: 'cli-bundle',
          status: 'warning' as const,
          message: 'bundle is stale',
          remediation: 'run pnpm run bundle',
        },
      ],
      summary: { ok: 1, warnings: 1, errors: 0 },
    };
    expect(formatJson(DoctorOutputSchema, data).success).toBe(true);
  });

  it('rejects drift: invalid status enum', () => {
    const data = {
      checks: [{ name: 'foo', status: 'unknown', message: 'x' }],
      summary: { ok: 0, warnings: 0, errors: 0 },
    } as unknown;
    expect(() => formatJson(DoctorOutputSchema, data)).toThrow(/contract drift.*status/i);
  });

  it('rejects drift: summary errors as a string', () => {
    const data = {
      checks: [],
      summary: { ok: 0, warnings: 0, errors: 'zero' },
    } as unknown;
    expect(() => formatJson(DoctorOutputSchema, data)).toThrow(/contract drift.*errors/i);
  });
});

describe('SkipAddOutputSchema (#1148)', () => {
  it('round-trips a successful append', () => {
    const data = {
      added: true,
      alreadyPresent: false,
      url: 'https://github.com/foo/bar/issues/1',
      path: '/tmp/skipped.md',
      date: '2026-04-25',
    };
    expect(formatJson(SkipAddOutputSchema, data).success).toBe(true);
  });

  it('round-trips a no-op (already present)', () => {
    const data = {
      added: false,
      alreadyPresent: true,
      url: 'https://github.com/foo/bar/issues/1',
      path: '/tmp/skipped.md',
    };
    expect(formatJson(SkipAddOutputSchema, data).success).toBe(true);
  });

  it('rejects drift: missing url', () => {
    const data = { added: true, alreadyPresent: false, path: '/tmp/x.md' } as unknown;
    expect(() => formatJson(SkipAddOutputSchema, data)).toThrow(/contract drift.*url/i);
  });
});

describe('ListMoveTierOutputSchema (#1148)', () => {
  it('round-trips a successful move', () => {
    const data = {
      moved: true,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      toTier: 'skip' as const,
      fromTier: 'Pursue',
      count: 1,
    };
    expect(formatJson(ListMoveTierOutputSchema, data).success).toBe(true);
  });

  it('round-trips a no-op move with reason', () => {
    const data = {
      moved: false,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      toTier: 'pursue' as const,
      count: 0,
      reason: 'already in target tier',
    };
    expect(formatJson(ListMoveTierOutputSchema, data).success).toBe(true);
  });

  it('rejects drift: invalid tier enum', () => {
    const data = {
      moved: true,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      toTier: 'archive',
      count: 1,
    } as unknown;
    expect(() => formatJson(ListMoveTierOutputSchema, data)).toThrow(/contract drift.*totier/i);
  });
});

describe('ListMarkDoneOutputSchema (#1299)', () => {
  it('round-trips a successful mark', () => {
    const data = {
      marked: true,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      repoHeadingStruck: false,
      remainingUnderRepo: 2,
    };
    expect(formatJson(ListMarkDoneOutputSchema, data).success).toBe(true);
  });

  it('round-trips a no-op mark with reason', () => {
    const data = {
      marked: false,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      repoHeadingStruck: false,
      remainingUnderRepo: 0,
      reason: 'already marked done',
    };
    expect(formatJson(ListMarkDoneOutputSchema, data).success).toBe(true);
  });

  it('rejects drift: missing repoHeadingStruck', () => {
    const data = {
      marked: true,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      remainingUnderRepo: 2,
    } as unknown;
    expect(() => formatJson(ListMarkDoneOutputSchema, data)).toThrow(/contract drift.*repoheadingstruck/i);
  });

  it('rejects drift: negative remainingUnderRepo', () => {
    const data = {
      marked: true,
      filePath: '/tmp/list.md',
      url: 'https://github.com/foo/bar/issues/1',
      repoHeadingStruck: false,
      remainingUnderRepo: -1,
    } as unknown;
    expect(() => formatJson(ListMarkDoneOutputSchema, data)).toThrow(/contract drift.*remainingunderrepo/i);
  });
});

describe('Misc command schemas (#1155)', () => {
  it('PostOutputSchema round-trip + drift', () => {
    expect(formatJson(PostOutputSchema, { commentUrl: 'a', url: 'b' }).success).toBe(true);
    expect(() => formatJson(PostOutputSchema, { commentUrl: 'a' })).toThrow(/contract drift.*url/i);
  });

  it('ClaimOutputSchema round-trip + drift', () => {
    expect(formatJson(ClaimOutputSchema, { commentUrl: 'a', issueUrl: 'b' }).success).toBe(true);
    expect(() => formatJson(ClaimOutputSchema, { commentUrl: 'a' })).toThrow(/contract drift.*issueurl/i);
  });

  it('InitOutputSchema round-trip + drift', () => {
    expect(formatJson(InitOutputSchema, { username: 'foo', message: 'ok' }).success).toBe(true);
    expect(() => formatJson(InitOutputSchema, { username: 'foo' })).toThrow(/contract drift.*message/i);
    // gistSyncWarning must survive validation, not get stripped (#1440)
    const withWarning = formatJson(InitOutputSchema, { username: 'foo', message: 'ok', gistSyncWarning: 'w' });
    expect(withWarning.data).toHaveProperty('gistSyncWarning', 'w');
  });

  it('CheckSetupOutputSchema accepts both setupComplete states', () => {
    expect(formatJson(CheckSetupOutputSchema, { setupComplete: true, username: 'a' }).success).toBe(true);
    expect(formatJson(CheckSetupOutputSchema, { setupComplete: false, username: '' }).success).toBe(true);
    expect(() => formatJson(CheckSetupOutputSchema, { setupComplete: 'yes', username: 'a' })).toThrow(
      /contract drift/i,
    );
  });

  it('SetupOutputSchema accepts all three union variants', () => {
    expect(formatJson(SetupOutputSchema, { success: true, settings: { a: 'b' } }).success).toBe(true);
    // gistSyncWarning must survive validation, not get stripped (#1440)
    expect(
      formatJson(SetupOutputSchema, { success: true, settings: { a: 'b' }, gistSyncWarning: 'w' }).data,
    ).toHaveProperty('gistSyncWarning', 'w');
    expect(
      formatJson(SetupOutputSchema, {
        setupComplete: true,
        config: {
          githubUsername: 'x',
          maxActivePRs: 5,
          dormantThresholdDays: 30,
          approachingDormantDays: 25,
          languages: [],
          labels: [],
          projectCategories: [],
          preferredOrgs: [],
          scope: [],
          persistence: 'local',
        },
      }).success,
    ).toBe(true);
    expect(formatJson(SetupOutputSchema, { setupRequired: true, prompts: [] }).success).toBe(true);
  });

  it('ConfigCommandOutputSchema accepts all three union variants', () => {
    expect(formatJson(ConfigCommandOutputSchema, { config: { foo: 'bar' } }).success).toBe(true);
    expect(formatJson(ConfigCommandOutputSchema, { success: true, key: 'k', value: 'v' }).success).toBe(true);
    expect(formatJson(ConfigCommandOutputSchema, { keys: [{ key: 'a' }] }).success).toBe(true);
    // gistSyncWarning must survive validation, not get stripped (#1440)
    expect(
      formatJson(ConfigCommandOutputSchema, { success: true, key: 'k', value: 'v', gistSyncWarning: 'w' }).data,
    ).toHaveProperty('gistSyncWarning', 'w');
  });

  it('MoveOutputSchema round-trip + drift on target enum', () => {
    expect(formatJson(MoveOutputSchema, { url: 'u', target: 'attention', description: 'd' }).success).toBe(true);
    expect(() => formatJson(MoveOutputSchema, { url: 'u', target: 'invalid', description: 'd' })).toThrow(
      /contract drift.*target/i,
    );
  });

  it('PRTemplateOutputSchema accepts null template/source', () => {
    expect(formatJson(PRTemplateOutputSchema, { template: 'body', source: '.github/PR.md' }).success).toBe(true);
    expect(formatJson(PRTemplateOutputSchema, { template: null, source: null }).success).toBe(true);
    expect(formatJson(PRTemplateOutputSchema, { template: null, source: null, error: 'oops' }).success).toBe(true);
  });

  it('ParseIssueListOutputSchema round-trip with items', () => {
    const data = {
      available: [{ repo: 'a/b', number: 1, title: 't', tier: 'pursue', url: 'u', score: 8 }],
      completed: [],
      availableCount: 1,
      completedCount: 0,
    };
    expect(formatJson(ParseIssueListOutputSchema, data).success).toBe(true);
  });

  it('CheckIntegrationOutputSchema round-trip', () => {
    expect(formatJson(CheckIntegrationOutputSchema, { newFiles: [], unreferencedCount: 0 }).success).toBe(true);
  });

  it('DetectFormattersOutputSchema round-trip with formatters', () => {
    const data = {
      formatters: [
        {
          name: 'prettier' as const,
          configPath: '.prettierrc',
          fixCommand: 'npx prettier --write .',
          checkCommand: 'npx prettier --check .',
          supportsFileArgs: true,
        },
      ],
      packageJsonScripts: [{ name: 'lint', command: 'eslint .' }],
      repoPath: '/repo',
    };
    expect(formatJson(DetectFormattersOutputSchema, data).success).toBe(true);
  });

  it('LocalReposOutputSchema round-trip', () => {
    const data = {
      repos: { 'a/b': { path: '/p', exists: true, currentBranch: 'main' } },
      scanPaths: ['/p'],
      cachedAt: '2026-04-25',
      fromCache: false,
    };
    expect(formatJson(LocalReposOutputSchema, data).success).toBe(true);
  });
});

// ── Envelope-level gist degradation warning (#1433) ───────────────────────

describe('setEnvelopeGistWarning', () => {
  afterEach(() => {
    setEnvelopeGistWarning(null);
  });

  it('threads the warning into success AND error envelopes once set', () => {
    setEnvelopeGistWarning('Gist persistence is configured but this run is LOCAL-ONLY');
    expect(jsonSuccess({ ok: true }).gistInitWarning).toMatch(/LOCAL-ONLY/);
    expect(jsonError('boom').gistInitWarning).toMatch(/LOCAL-ONLY/);
  });

  it('is absent (not null) when unset, keeping the wire format minimal', () => {
    expect('gistInitWarning' in jsonSuccess({ ok: true })).toBe(false);
    expect('gistInitWarning' in jsonError('boom')).toBe(false);
  });

  // ── Dedup (#1444): commands that own a warnings[] array report gist-init
  // degradation exactly once, there — the envelope must not restate it.

  it('suppresses the envelope duplicate when the payload carries warnings[{phase:"gist-init"}]', () => {
    setEnvelopeGistWarning('Gist persistence is configured but this run is LOCAL-ONLY');
    const data = {
      warnings: [{ phase: 'gist-init', operation: 'Gist persistence degraded', message: 'degraded' }],
    };
    expect('gistInitWarning' in jsonSuccess(data)).toBe(false);
  });

  it('keeps the envelope warning when the payload warnings carry other phases only', () => {
    setEnvelopeGistWarning('Gist persistence is configured but this run is LOCAL-ONLY');
    const data = { warnings: [{ phase: 'fetch', operation: 'fetch PRs', message: 'boom' }] };
    expect(jsonSuccess(data).gistInitWarning).toMatch(/LOCAL-ONLY/);
  });

  it('keeps the envelope warning on error envelopes (no payload to carry it)', () => {
    setEnvelopeGistWarning('Gist persistence is configured but this run is LOCAL-ONLY');
    expect(jsonError('boom').gistInitWarning).toMatch(/LOCAL-ONLY/);
  });
});

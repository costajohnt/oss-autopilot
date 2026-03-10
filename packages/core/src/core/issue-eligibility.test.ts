import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  checkNoExistingPR,
  checkNotClaimed,
  checkUserMergedPRsInRepo,
  analyzeRequirements,
} from './issue-eligibility.js';
import type { Octokit } from '@octokit/rest';

// ── Mock dependencies ──

vi.mock('./pagination.js', () => ({
  paginateAll: vi.fn().mockResolvedValue([]),
}));

vi.mock('./logger.js', () => ({
  warn: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
}));

import { paginateAll } from './pagination.js';
import { warn } from './logger.js';

// ── Helpers ──

/** Safely cast a nested octokit method to a vi.fn mock. */
function mockFn(fn: unknown): ReturnType<typeof vi.fn> {
  return fn as ReturnType<typeof vi.fn>;
}

function makeOctokit(): Octokit {
  return {
    issues: {
      get: vi.fn(),
      listEventsForTimeline: vi.fn(),
      listComments: vi.fn(),
    },
    search: {
      issuesAndPullRequests: vi.fn(),
    },
    paginate: vi.fn(),
  } as unknown as Octokit;
}

// ── Global setup ──

beforeEach(() => {
  vi.mocked(warn).mockClear();
});

// ── Tests ──

describe('analyzeRequirements', () => {
  it('returns false for empty body', () => {
    expect(analyzeRequirements('')).toBe(false);
  });

  it('returns false for body shorter than 50 characters', () => {
    expect(analyzeRequirements('Fix the bug in the login page.')).toBe(false);
  });

  it('returns false with only one clarity indicator', () => {
    const body = '1. First step to reproduce the problem right here.\nSomething happens that is quite broken here.';
    expect(analyzeRequirements(body)).toBe(false);
  });

  it('returns true with numbered steps + expected behavior', () => {
    const body =
      '1. Go to the settings page and click the button.\n2. Enter a value and submit the form.\nThe app should display a success message after submission.';
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns true with code block + length > 200', () => {
    const body = '```\nconst x = 1;\nconsole.log(x);\n```\n' + 'A'.repeat(200);
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns true with bullet steps + code block', () => {
    const body =
      '- Run the following command:\n```\nnpm install\n```\nThen check output for errors in the console output area.';
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('returns true with all four indicators', () => {
    const body = '1. Step one\n```\ncode\n```\nExpected: should work. ' + 'A'.repeat(200);
    expect(analyzeRequirements(body)).toBe(true);
  });

  it('detects asterisk bullet lists', () => {
    const body =
      '* First item in the list here\n* Second item in the list here\nIt should display correctly when rendered.';
    expect(analyzeRequirements(body)).toBe(true);
  });
});

describe('checkNoExistingPR', () => {
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
    vi.mocked(paginateAll).mockResolvedValue([]);
  });

  it('returns passed when no PRs found', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });

    const result = await checkNoExistingPR(octokit, 'owner', 'repo', 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBeUndefined();
  });

  it('returns not passed when search finds PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 1, items: [{}] },
    });

    const result = await checkNoExistingPR(octokit, 'owner', 'repo', 1);
    expect(result.passed).toBe(false);
    expect(result.inconclusive).toBeUndefined();
  });

  it('returns not passed when timeline has linked PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    vi.mocked(paginateAll).mockResolvedValue([{ event: 'cross-referenced', source: { issue: { pull_request: {} } } }]);

    const result = await checkNoExistingPR(octokit, 'owner', 'repo', 1);
    expect(result.passed).toBe(false);
  });

  it('ignores non-PR cross-references', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0, items: [] },
    });
    vi.mocked(paginateAll).mockResolvedValue([
      { event: 'cross-referenced', source: { issue: {} } }, // no pull_request
      { event: 'labeled' }, // different event type
    ]);

    const result = await checkNoExistingPR(octokit, 'owner', 'repo', 1);
    expect(result.passed).toBe(true);
  });

  it('returns passed + inconclusive on API error and logs warning', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockRejectedValue(new Error('Network error'));

    const result = await checkNoExistingPR(octokit, 'owner', 'repo', 1);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('Network error');
    expect(warn).toHaveBeenCalledWith('issue-eligibility', expect.stringContaining('owner/repo#1'));
  });
});

describe('checkNotClaimed', () => {
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
  });

  it('returns passed immediately when commentCount is 0', async () => {
    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 0);
    expect(result.passed).toBe(true);
    expect(octokit.paginate).not.toHaveBeenCalled();
  });

  it('returns passed when no claim phrases found', async () => {
    mockFn(octokit.paginate).mockResolvedValue([
      { body: 'This is a great issue!' },
      { body: 'I agree, we should fix this.' },
    ]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 2);
    expect(result.passed).toBe(true);
  });

  it('returns not passed when claim phrase found', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: "I'm working on this already." }]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it.each([
    "i'll take this",
    'working on it',
    "i'd like to work on this",
    'assigned to me',
    "i'm on it",
    'working on a pr',
    "i'll submit a pr",
    'working on a fix',
  ])('detects claim phrase: "%s"', async (phrase) => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: phrase }]);
    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('is case-insensitive', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: "I'M WORKING ON THIS" }]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 1);
    expect(result.passed).toBe(false);
  });

  it('handles comments with null body', async () => {
    mockFn(octokit.paginate).mockResolvedValue([{ body: null }, { body: '' }]);

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 2);
    expect(result.passed).toBe(true);
  });

  it('returns passed + inconclusive on API error and logs warning', async () => {
    mockFn(octokit.paginate).mockRejectedValue(new Error('API down'));

    const result = await checkNotClaimed(octokit, 'owner', 'repo', 1, 5);
    expect(result.passed).toBe(true);
    expect(result.inconclusive).toBe(true);
    expect(result.reason).toBe('API down');
    expect(warn).toHaveBeenCalledWith('issue-eligibility', expect.stringContaining('owner/repo#1'));
  });
});

describe('checkUserMergedPRsInRepo', () => {
  let octokit: ReturnType<typeof makeOctokit>;

  beforeEach(() => {
    octokit = makeOctokit();
  });

  it('returns count of merged PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 3 },
    });

    const count = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(count).toBe(3);
  });

  it('returns 0 when no merged PRs', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockResolvedValue({
      data: { total_count: 0 },
    });

    const count = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(count).toBe(0);
  });

  it('returns 0 on API error and logs warning', async () => {
    mockFn(octokit.search.issuesAndPullRequests).mockRejectedValue(new Error('API error'));

    const count = await checkUserMergedPRsInRepo(octokit, 'owner', 'repo');
    expect(count).toBe(0);
    expect(warn).toHaveBeenCalledWith('issue-eligibility', expect.stringContaining('owner/repo'));
  });
});

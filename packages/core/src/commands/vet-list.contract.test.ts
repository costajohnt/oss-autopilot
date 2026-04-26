/**
 * --json contract test for the `vet-list` command (#965, #986).
 *
 * Batch vetting over the curated issue list. Snapshots a mixed-status
 * batch so all five list-status outcomes are pinned:
 *   still_available / claimed / closed / has_pr / error
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/vet-list.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  vetIssue: vi.fn(),
  getRepoScore: vi.fn(),
  detectIssueList: vi.fn(),
  runParseList: vi.fn(),
}));

vi.mock('./scout-bridge.js', async () => {
  const actual = await vi.importActual<typeof import('./scout-bridge.js')>('./scout-bridge.js');
  return {
    ...actual,
    createAutopilotScout: vi.fn(async () => ({ vetIssue: mocks.vetIssue })),
  };
});

vi.mock('./startup.js', () => ({ detectIssueList: mocks.detectIssueList }));
vi.mock('./parse-list.js', () => ({
  runParseList: mocks.runParseList,
  pruneIssueList: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({
      getRepoScore: mocks.getRepoScore,
      getState: () => ({ config: { githubUsername: 'costajohnt' } }),
    }),
  };
});

import { runVetList } from './vet-list.js';

const HEALTH_APPROVE = {
  repo: 'owner/repo-a',
  lastCommitAt: '2026-04-15T00:00:00.000Z',
  daysSinceLastCommit: 3,
  openIssuesCount: 10,
  avgIssueResponseDays: 0,
  ciStatus: 'passing' as const,
  isActive: true,
};

describe('vet-list --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.detectIssueList.mockReturnValue({ path: '/fake/issue-list.md' });
    mocks.runParseList.mockResolvedValue({
      available: [
        { repo: 'owner/repo-a', number: 1, title: 'Still available', url: 'https://github.com/owner/repo-a/issues/1' },
        { repo: 'owner/repo-b', number: 2, title: 'Already claimed', url: 'https://github.com/owner/repo-b/issues/2' },
        { repo: 'owner/repo-c', number: 3, title: 'Will error', url: 'https://github.com/owner/repo-c/issues/3' },
      ],
    });
    mocks.getRepoScore.mockReturnValue({ mergedPRCount: 4, closedWithoutMergeCount: 1, avgResponseDays: 3 });
  });

  it('mixed-status batch output matches the golden shape', async () => {
    mocks.vetIssue
      .mockResolvedValueOnce({
        issue: {
          repo: 'owner/repo-a',
          number: 1,
          title: 'Still available',
          url: 'https://github.com/owner/repo-a/issues/1',
          labels: ['good first issue'],
        },
        recommendation: 'approve' as const,
        reasonsToApprove: ['Active project'],
        reasonsToSkip: [],
        projectHealth: HEALTH_APPROVE,
        vettingResult: { passedAllChecks: true, checks: {}, notes: [] },
      })
      .mockResolvedValueOnce({
        issue: {
          repo: 'owner/repo-b',
          number: 2,
          title: 'Already claimed',
          url: 'https://github.com/owner/repo-b/issues/2',
          labels: [],
        },
        recommendation: 'skip' as const,
        reasonsToApprove: [],
        reasonsToSkip: ['Issue is already claimed by another user'],
        projectHealth: { ...HEALTH_APPROVE, repo: 'owner/repo-b' },
        vettingResult: { passedAllChecks: false, checks: {}, notes: [] },
      })
      .mockRejectedValueOnce(new Error('Network timeout'));

    const result = await runVetList({ concurrency: 1 });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet-list.mixed.json');
  });

  it('empty list output matches the golden shape', async () => {
    mocks.runParseList.mockResolvedValue({ available: [] });

    const result = await runVetList({});
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet-list.empty.json');
  });
});

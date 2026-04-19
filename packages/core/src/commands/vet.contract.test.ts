/**
 * --json contract test for the `vet` command (#965).
 *
 * Golden-file test — mocks `@oss-scout/core`'s `vetIssue()` with a
 * deterministic candidate payload and snapshots the full shape of
 * `runVet`'s output. Any added/renamed/removed field breaks this test.
 *
 * Update the golden on intentional shape changes with:
 *   npx vitest run -u src/commands/vet.contract.test.ts
 *
 * Scope note: `VetOutput.projectHealth` and `VetOutput.vettingResult`
 * are typed `unknown` and passed straight through from `@oss-scout/core`.
 * The goldens therefore pin "whatever the mock emits" for those two
 * nested objects, not scout's real wire contract. Breakage originating
 * in scout must be caught by scout's own tests; once autopilot narrows
 * those fields to concrete types (or scout ships its own contract
 * tests), this test will cover them too.
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mockVetIssue = vi.fn();
const mockGetRepoScore = vi.fn();

vi.mock('./scout-bridge.js', () => ({
  createAutopilotScout: vi.fn(async () => ({ vetIssue: mockVetIssue })),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({ getRepoScore: mockGetRepoScore }),
  };
});

import { runVet } from './vet.js';

const TEST_ISSUE_URL = 'https://github.com/owner/repo/issues/42';

describe('vet --json contract', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks) also drops previously-registered
    // mockResolvedValue / mockReturnValue implementations, so a future
    // test that forgets to mock cannot silently inherit the previous
    // test's fixture and pass for the wrong reason.
    vi.resetAllMocks();
  });

  it('approve-recommendation output matches the golden shape', async () => {
    mockVetIssue.mockResolvedValue({
      issue: {
        repo: 'owner/repo',
        number: 42,
        title: 'Improve error handling in foo()',
        url: TEST_ISSUE_URL,
        labels: ['good first issue', 'bug'],
      },
      recommendation: 'approve',
      reasonsToApprove: ['Active maintainers', 'Clear scope', 'Good first issue label'],
      reasonsToSkip: [],
      projectHealth: {
        repo: 'owner/repo',
        lastCommitAt: '2026-04-15T00:00:00.000Z',
        daysSinceLastCommit: 3,
        openIssuesCount: 42,
        avgIssueResponseDays: 0,
        ciStatus: 'passing',
        isActive: true,
      },
      vettingResult: {
        passedAllChecks: true,
        checks: {
          noExistingPR: true,
          notClaimed: true,
          projectActive: true,
          clearRequirements: true,
          contributionGuidelinesFound: true,
        },
        notes: [],
      },
    });
    mockGetRepoScore.mockReturnValue({
      mergedPRCount: 12,
      closedWithoutMergeCount: 3,
      avgResponseDays: 4,
    });

    const result = await runVet({ issueUrl: TEST_ISSUE_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet.approve.json');
  });

  it('skip-recommendation output matches the golden shape', async () => {
    mockVetIssue.mockResolvedValue({
      issue: {
        repo: 'owner/repo',
        number: 99,
        title: 'Already claimed issue',
        url: 'https://github.com/owner/repo/issues/99',
        labels: [],
      },
      recommendation: 'skip',
      reasonsToApprove: [],
      reasonsToSkip: ['Issue already has a linked PR'],
      projectHealth: {
        repo: 'owner/repo',
        lastCommitAt: '2026-01-01T00:00:00.000Z',
        daysSinceLastCommit: 100,
        openIssuesCount: 500,
        avgIssueResponseDays: 0,
        ciStatus: 'unknown',
        isActive: false,
        checkFailed: true,
        failureReason: 'Rate limited',
      },
      vettingResult: {
        passedAllChecks: false,
        checks: {
          noExistingPR: false,
          notClaimed: true,
          projectActive: false,
          clearRequirements: true,
          contributionGuidelinesFound: false,
        },
        notes: ['Linked PR already exists'],
      },
    });
    mockGetRepoScore.mockReturnValue(undefined);

    const result = await runVet({ issueUrl: 'https://github.com/owner/repo/issues/99' });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/vet.skip.json');
  });
});

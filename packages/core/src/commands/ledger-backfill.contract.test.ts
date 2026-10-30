/**
 * --json contract test for the `ledger-backfill` command (#1824).
 *
 * Golden-file test: an in-memory ledger, a canned GraphQL answer, no
 * curated list. Update goldens on intentional shape changes with:
 *   npx vitest run -u src/commands/ledger-backfill.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';
import { StateManager } from '../core/state.js';

const mocks = vi.hoisted(() => ({ graphql: vi.fn(), state: { current: undefined as unknown } }));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => mocks.state.current,
    getOctokit: () => ({ graphql: mocks.graphql }),
    requireGitHubToken: () => 'token',
  };
});
vi.mock('./locate-issue-list.js', () => ({ detectIssueListPath: () => undefined }));

import { runLedgerBackfill } from './ledger-backfill.js';

describe('ledger-backfill --json contract', () => {
  beforeEach(() => {
    const sm = new StateManager(true);
    sm.addMergedPRs([{ url: 'https://github.com/octo/alpha/pull/1', title: 'm', mergedAt: '2026-10-10T00:00:00Z' }]);
    sm.addClosedPRs([{ url: 'https://github.com/octo/alpha/pull/2', title: 'c', closedAt: '2026-10-12T00:00:00Z' }]);
    mocks.state.current = sm;
    mocks.graphql.mockResolvedValue({
      p0: {
        pullRequest: {
          createdAt: '2026-10-01T00:00:00Z',
          author: { __typename: 'User', login: 'me' },
          closingIssuesReferences: { nodes: [{ url: 'https://github.com/octo/alpha/issues/9' }] },
          timelineItems: { nodes: [] },
          comments: { nodes: [] },
        },
      },
      p1: null,
    });
  });

  it('output matches the golden shape', async () => {
    const result = await runLedgerBackfill();
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/ledger-backfill.json');
  });
});

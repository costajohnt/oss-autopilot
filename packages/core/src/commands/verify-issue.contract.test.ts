/**
 * --json contract test for the `verify-issue` command (#1353, #1354).
 *
 * Mocks octokit.graphql with a fixture exercising the full output shape
 * (closed issue, stateReason, ghost author, draft PR, both linkTypes,
 * null updatedAt), then asserts the result round-trips through
 * `VerifyIssueOutputSchema` unchanged. The deep-equal catches BOTH drift
 * directions: a producer field the schema rejects (runtime throw) and a
 * producer field the schema silently strips (z.object drops unknown keys).
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/verify-issue.contract.test.ts
 */

import { describe, it, vi, expect } from 'vitest';

const mocks = vi.hoisted(() => ({
  graphql: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getOctokit: vi.fn().mockReturnValue({ graphql: mocks.graphql }),
    requireGitHubToken: vi.fn().mockReturnValue('fake-token'),
  };
});

import { runVerifyIssue } from './verify-issue.js';
import { formatJson, VerifyIssueOutputSchema } from '../formatters/json.js';

const ISSUE_URL = 'https://github.com/foo/bar/issues/42';

describe('verify-issue --json contract', () => {
  it('a fully populated verification round-trips through VerifyIssueOutputSchema unchanged', async () => {
    mocks.graphql.mockResolvedValue({
      viewer: { login: 'testuser' },
      repository: {
        issue: {
          number: 42,
          title: 'Fix the widget',
          url: ISSUE_URL,
          state: 'CLOSED',
          stateReason: 'COMPLETED',
          closedAt: '2026-06-01T00:00:00Z',
          assignees: { nodes: [{ login: 'maintainer' }] },
          timelineItems: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [
              {
                source: {
                  number: 7,
                  url: 'https://github.com/foo/bar/pull/7',
                  title: 'fixes the widget',
                  state: 'MERGED',
                  isDraft: false,
                  updatedAt: '2026-05-30T00:00:00Z',
                  author: { login: 'TestUser' },
                  closingIssuesReferences: {
                    nodes: [{ number: 42, repository: { nameWithOwner: 'foo/bar' } }],
                  },
                },
              },
              {
                source: {
                  number: 9,
                  url: 'https://github.com/foo/bar/pull/9',
                  title: 'broader refactor',
                  state: 'OPEN',
                  isDraft: true,
                  updatedAt: null,
                  author: null, // ghost account
                  closingIssuesReferences: { nodes: [] },
                },
              },
            ],
          },
        },
      },
    });

    const result = await runVerifyIssue({ issueUrl: ISSUE_URL });

    // Round-trip: validated output must deep-equal the producer output.
    const envelope = formatJson(VerifyIssueOutputSchema, result);
    expect(envelope.success).toBe(true);
    expect(envelope.data).toEqual(result);

    // Snapshot the full agent-facing shape.
    expect(result).toMatchSnapshot();
  });
});

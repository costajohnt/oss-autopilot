/**
 * --json contract test for the `track` command (#965, #997).
 *
 * runTrack is a v2 informational lookup that fetches PR metadata from GitHub
 * and returns it. It does not mutate state. The golden pins the TrackOutput
 * shape so the plugin and MCP server cannot silently drift apart from the CLI.
 *
 * Update on intentional shape changes with:
 *   npx vitest run -u src/commands/track.contract.test.ts
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

const mockPullsGet = vi.fn();

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getOctokit: vi.fn(() => ({ pulls: { get: mockPullsGet } })),
    requireGitHubToken: vi.fn(() => 'ghp_fake_token'),
  };
});

import { runTrack } from './track.js';

const TEST_PR_URL = 'https://github.com/owner/repo/pull/42';

describe('track --json contract', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('output matches the golden shape', async () => {
    mockPullsGet.mockResolvedValue({
      data: { title: 'Improve error handling in foo()' },
    });

    const result = await runTrack({ prUrl: TEST_PR_URL });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/track.json');
  });
});

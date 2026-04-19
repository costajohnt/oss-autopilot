/**
 * --json contract test for the `status` command (#965).
 *
 * This is a golden-file test: we run `runStatus` with deterministic
 * fixtures and compare the full output to `__golden__/status.json`.
 * If the emitted shape drifts (field added, renamed, removed, or
 * re-typed), this test fails with a diff showing exactly what moved.
 *
 * Intentional shape changes: update the golden file by running
 *   `npx vitest run -u src/commands/status.contract.test.ts`
 * and review the diff in the same PR. Any update that is not
 * strictly additive is a breaking change to the plugin/MCP layer.
 */

import { describe, it, vi, beforeEach, expect } from 'vitest';

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(),
}));

import { getStateManager } from '../core/index.js';
import { runStatus } from './status.js';

const mockGetStateManager = vi.mocked(getStateManager);

const DETERMINISTIC_STATS = {
  mergedPRs: 5,
  closedPRs: 2,
  activeIssues: 0,
  trustedProjects: 1,
  mergeRate: '71.4%',
  needsResponse: 0,
};

const DETERMINISTIC_STATE = {
  lastRunAt: '2026-01-15T10:00:00.000Z',
  lastDigestAt: '2026-01-15T09:30:00.000Z',
};

describe('status --json contract', () => {
  beforeEach(() => {
    // Reset implementations along with call history — see vet.contract.test.ts
    // for rationale.
    vi.resetAllMocks();
    mockGetStateManager.mockReturnValue({
      getStats: vi.fn().mockReturnValue(DETERMINISTIC_STATS),
      getState: vi.fn().mockReturnValue(DETERMINISTIC_STATE),
    } as unknown as ReturnType<typeof getStateManager>);
  });

  it('online mode output matches the golden shape', async () => {
    const result = await runStatus({});
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/status.online.json');
  });

  it('offline mode output matches the golden shape', async () => {
    const result = await runStatus({ offline: true });
    await expect(JSON.stringify(result, null, 2)).toMatchFileSnapshot('./__golden__/status.offline.json');
  });
});

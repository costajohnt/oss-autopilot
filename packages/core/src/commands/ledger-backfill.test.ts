import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

const { runLedgerBackfill } = await import('./ledger-backfill.js');

const MERGED = 'https://github.com/o/r/pull/1';
const CLOSED = 'https://github.com/o/r/pull/2';

describe('runLedgerBackfill (#1824)', () => {
  let sm: StateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = new StateManager(true);
    mocks.state.current = sm;
    sm.addMergedPRs([{ url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z' }]);
    sm.addClosedPRs([{ url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z' }]);
  });

  it('fills openedAt, issueUrl and closeReason from one batched query', async () => {
    mocks.graphql.mockResolvedValue({
      p0: {
        pullRequest: {
          createdAt: '2026-01-01T00:00:00Z',
          author: { login: 'me' },
          closingIssuesReferences: { nodes: [{ url: 'https://github.com/o/r/issues/9' }] },
          timelineItems: { nodes: [] },
          comments: { nodes: [] },
        },
      },
      p1: {
        pullRequest: {
          createdAt: '2025-12-30T00:00:00Z',
          author: { login: 'me' },
          closingIssuesReferences: { nodes: [] },
          timelineItems: { nodes: [{ actor: { login: 'maint' } }] },
          comments: { nodes: [{ author: { login: 'maint' }, body: 'Superseded by #5' }] },
        },
      },
    });

    const result = await runLedgerBackfill();

    expect(mocks.graphql).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      queried: 2,
      unresolved: 0,
      filled: { openedAt: 2, issueUrl: 1, closeReason: 1, pick: 0 },
    });
    expect(sm.getMergedPRs()[0]).toMatchObject({
      openedAt: '2026-01-01T00:00:00Z',
      issueUrl: 'https://github.com/o/r/issues/9',
    });
    expect(sm.getClosedPRs()[0].closeReason).toBe('superseded');
  });

  it('keeps partial data when one repo errors, and rethrows rate limits', async () => {
    const partial = Object.assign(new Error('partial'), {
      data: { p0: { pullRequest: { createdAt: '2026-01-01T00:00:00Z' } }, p1: null },
    });
    mocks.graphql.mockRejectedValueOnce(partial);
    const result = await runLedgerBackfill();
    expect(result.unresolved).toBe(1);
    expect(sm.getMergedPRs()[0].openedAt).toBe('2026-01-01T00:00:00Z');

    mocks.graphql.mockRejectedValueOnce(Object.assign(new Error('limited'), { errors: [{ type: 'RATE_LIMITED' }] }));
    await expect(runLedgerBackfill()).rejects.toThrow('limited');
  });

  it('imports the curated list score for a PR its status line links', async () => {
    mocks.graphql.mockResolvedValue({});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-backfill-'));
    const list = path.join(dir, 'issues.md');
    fs.writeFileSync(list, '# Issues\n\n## Pursue\n\n- [o/r#9](https://github.com/o/r/issues/9) - title\n');
    fs.writeFileSync(
      path.join(dir, 'issues-archive-2026-01-01.md'),
      `# Archive\n\n## Pursue\n\n- [o/r#9](https://github.com/o/r/issues/9) - title\n  - **Pursue (7/10)** - good\n  - **Done** - PR [#1](${MERGED})\n`,
    );

    const result = await runLedgerBackfill({ issueListPath: list });

    expect(result.listFiles).toHaveLength(2);
    expect(result.filled.pick).toBe(1);
    expect(sm.getMergedPRs()[0]).toMatchObject({
      issueUrl: 'https://github.com/o/r/issues/9',
      pick: { grade: 7, source: 'list', issueUrl: 'https://github.com/o/r/issues/9' },
    });
  });

  it('skips GitHub entirely when nothing is missing', async () => {
    sm.addMergedPRs([{ url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z', openedAt: 'x', issueUrl: 'y' }]);
    sm.addClosedPRs([
      { url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z', openedAt: 'x', issueUrl: 'y', closeReason: 'stale' },
    ]);
    expect((await runLedgerBackfill()).queried).toBe(0);
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
});

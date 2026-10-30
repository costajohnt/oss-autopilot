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
const ISSUE = 'https://github.com/o/r/issues/9';

const node = (extra: object = {}) => ({
  pullRequest: {
    createdAt: '2026-01-01T00:00:00Z',
    author: { __typename: 'User', login: 'me' },
    closingIssuesReferences: { nodes: [] },
    timelineItems: { nodes: [] },
    comments: { nodes: [] },
    ...extra,
  },
});

function writeList(entry: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-backfill-'));
  const list = path.join(dir, 'issues.md');
  fs.writeFileSync(list, '# Issues\n\n## Pursue\n\n');
  fs.writeFileSync(path.join(dir, 'issues-archive-2026-01-01.md'), `# Archive\n\n## Pursue\n\n${entry}`);
  return list;
}

describe('runLedgerBackfill (#1824)', () => {
  let sm: StateManager;

  beforeEach(() => {
    vi.clearAllMocks();
    sm = new StateManager(true);
    mocks.state.current = sm;
    sm.addMergedPRs([{ url: MERGED, title: 'm', mergedAt: '2026-01-02T00:00:00Z' }]);
    sm.addClosedPRs([{ url: CLOSED, title: 'c', closedAt: '2026-01-03T00:00:00Z' }]);
  });

  it('fills fields from one batched query, stamps entries, and skips them next run', async () => {
    mocks.graphql.mockResolvedValue({
      p0: node({ closingIssuesReferences: { nodes: [{ url: ISSUE }] } }),
      p1: node({
        timelineItems: { nodes: [{ actor: { __typename: 'User', login: 'maint' } }] },
        comments: { nodes: [{ author: { __typename: 'User', login: 'maint' }, body: 'Superseded by #5' }] },
      }),
    });

    const result = await runLedgerBackfill();

    expect(result).toMatchObject({
      queried: 2,
      unresolved: 0,
      warnings: ['no curated issue list found; list vet scores were not imported'],
      filled: { openedAt: 2, issueUrl: 1, closeReason: 1, pick: 0 },
    });
    expect(sm.getMergedPRs()[0]).toMatchObject({ openedAt: '2026-01-01T00:00:00Z', issueUrl: ISSUE });
    expect(sm.getMergedPRs()[0].backfilledAt).toBeDefined();
    expect(sm.getClosedPRs()[0].closeReason).toBe('superseded');

    expect((await runLedgerBackfill()).queried).toBe(0);
    expect(mocks.graphql).toHaveBeenCalledTimes(1);
  });

  it('treats a bot closer as stale and leaves the reason unset without a closed event', async () => {
    mocks.graphql.mockResolvedValue({
      p0: node(),
      p1: node({ timelineItems: { nodes: [{ actor: { __typename: 'Bot', login: 'github-actions' } }] } }),
    });
    await runLedgerBackfill();
    expect(sm.getClosedPRs()[0].closeReason).toBe('stale');

    sm.addClosedPRs([{ url: 'https://github.com/o/r/pull/3', title: 'c', closedAt: '2026-01-04T00:00:00Z' }]);
    mocks.graphql.mockResolvedValue({ p0: node() });
    await runLedgerBackfill();
    expect(sm.getClosedPRs().find((e) => e.url.endsWith('/3'))?.closeReason).toBeUndefined();
  });

  it('reports partial errors by type and keeps the PRs that resolved', async () => {
    mocks.graphql.mockRejectedValueOnce(
      Object.assign(new Error('partial'), { data: { p0: node(), p1: null }, errors: [{ type: 'NOT_FOUND' }] }),
    );
    const result = await runLedgerBackfill();
    expect(result.unresolved).toBe(1);
    expect(result.warnings).toContain('PRs GitHub did not return: NOT_FOUND x1');
    expect(sm.getMergedPRs()[0].openedAt).toBe('2026-01-01T00:00:00Z');
  });

  it('throws when every batch fails outright', async () => {
    mocks.graphql.mockRejectedValue(new Error('502 Bad Gateway'));
    await expect(runLedgerBackfill()).rejects.toThrow(
      /Every GitHub batch failed.*batch of 2 PRs failed: 502 Bad Gateway/,
    );
  });

  it('persists earlier batches before rethrowing a rate limit', async () => {
    for (let i = 3; i < 45; i++) {
      sm.addMergedPRs([{ url: `https://github.com/o/r/pull/${i}`, title: 'm', mergedAt: '2026-01-01T00:00:00Z' }]);
    }
    const first = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`p${i}`, node()]));
    mocks.graphql
      .mockResolvedValueOnce(first)
      .mockRejectedValueOnce(Object.assign(new Error('limited'), { errors: [{ type: 'RATE_LIMITED' }] }));

    await expect(runLedgerBackfill()).rejects.toThrow('limited');
    const stamped = [...sm.getMergedPRs(), ...sm.getClosedPRs()].filter((e) => e.backfilledAt);
    expect(stamped).toHaveLength(40);
  });

  it('rejects an explicit list path that does not exist', async () => {
    await expect(runLedgerBackfill({ issueListPath: '/nope/list.md' })).rejects.toThrow('Issue list not found');
    expect(mocks.graphql).not.toHaveBeenCalled();
  });

  it('imports the list score as a recommendation for a PR its status line links', async () => {
    mocks.graphql.mockResolvedValue({});
    const list = writeList(
      `- [o/r#9](${ISSUE}) - title\n  - **Pursue (7/10)** - good\n  - **Done** - PR [#1](${MERGED})\n`,
    );

    const result = await runLedgerBackfill({ issueListPath: list });

    expect(result.listFiles).toHaveLength(2);
    expect(result.filled.pick).toBe(1);
    expect(sm.getMergedPRs()[0]).toMatchObject({
      issueUrl: ISSUE,
      pick: { grade: 7, recommendation: 'approve', source: 'list', issueUrl: ISSUE },
    });
    expect(sm.getMergedPRs()[0].pick?.capturedAt).toBeUndefined();
  });

  it('prefers a vet-time snapshot over the list score', async () => {
    mocks.graphql.mockResolvedValue({ p0: node({ closingIssuesReferences: { nodes: [{ url: ISSUE }] } }), p1: node() });
    sm.recordPickSnapshots([{ issueUrl: ISSUE, grade: 9, recommendation: 'approve', source: 'vet', capturedAt: 'x' }]);
    const list = writeList(`- [o/r#9](${ISSUE}) - t\n  - **Pursue (6/10)** - ok\n  - **Done** - PR [#1](${MERGED})\n`);

    await runLedgerBackfill({ issueListPath: list });

    expect(sm.getMergedPRs()[0].pick).toMatchObject({ grade: 9, source: 'vet' });
  });

  it('ignores list entries whose own URL is a PR', async () => {
    mocks.graphql.mockResolvedValue({});
    const list = writeList(`- [o/r#1](${MERGED}) - t\n  - **Pursue (8/10)** - ok\n  - **Done** - PR [#1](${MERGED})\n`);
    expect((await runLedgerBackfill({ issueListPath: list })).filled.pick).toBe(0);
  });
});

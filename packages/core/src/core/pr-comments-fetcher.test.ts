import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Octokit } from '@octokit/rest';
import { fetchPRCommentBundle, fetchPRCommentBundlesBatch } from './pr-comments-fetcher.js';

// Note: paginateAll is NOT mocked — these tests exercise the real pagination
// loop. Existing tests use small data sets (< 100 items per list) so
// paginateAll naturally stops after page 1 (data.length < perPage); the
// '2-page' test below intentionally returns 100 items on page 1 to verify
// the loop continues to page 2 and concatenates correctly (#1209 L1).

// ── Fixture builders ────────────────────────────────────────────────────────

interface MockComment {
  user: { login: string; type?: string } | null;
  author_association?: string;
  body?: string;
  path?: string;
  created_at?: string;
  submitted_at?: string;
}

function makePR(overrides: Partial<{ title: string; merged_at: string | null; closed_at: string | null }> = {}) {
  return {
    title: 'Add feature X',
    merged_at: '2026-04-20T12:00:00Z',
    closed_at: null,
    ...overrides,
  };
}

function makeOctokit(opts: {
  pr?: ReturnType<typeof makePR>;
  reviews?: MockComment[];
  reviewComments?: MockComment[];
  issueComments?: MockComment[];
  failPrGet?: boolean;
}): Octokit {
  const pr = opts.pr ?? makePR();
  return {
    pulls: {
      get: vi.fn(async () => {
        if (opts.failPrGet) throw new Error('Not Found');
        return { data: pr };
      }),
      listReviews: vi.fn(async () => ({ data: opts.reviews ?? [] })),
      listReviewComments: vi.fn(async () => ({ data: opts.reviewComments ?? [] })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: opts.issueComments ?? [] })),
    },
  } as unknown as Octokit;
}

const PR_URL = 'https://github.com/owner/repo/pull/42';

describe('fetchPRCommentBundle', () => {
  it('returns a well-formed bundle for a valid PR URL', async () => {
    const octokit = makeOctokit({
      reviews: [
        {
          user: { login: 'maintainer1' },
          author_association: 'OWNER',
          body: 'Looks good with one nit.',
          submitted_at: '2026-04-20T10:00:00Z',
        },
      ],
      reviewComments: [
        {
          user: { login: 'maintainer1' },
          author_association: 'OWNER',
          body: 'Use camelCase here.',
          path: 'src/x.ts',
          created_at: '2026-04-20T10:01:00Z',
        },
      ],
      issueComments: [
        {
          user: { login: 'maintainer2' },
          author_association: 'COLLABORATOR',
          body: 'Thanks for the contribution!',
          created_at: '2026-04-20T11:00:00Z',
        },
      ],
    });

    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');

    expect(bundle.prUrl).toBe(PR_URL);
    expect(bundle.prTitle).toBe('Add feature X');
    expect(bundle.repo).toBe('owner/repo');
    expect(bundle.mergedAt).toBe('2026-04-20T12:00:00Z');
    expect(bundle.reviews).toHaveLength(1);
    expect(bundle.reviews[0]).toMatchObject({
      author: 'maintainer1',
      authorAssociation: 'OWNER',
      body: 'Looks good with one nit.',
    });
    expect(bundle.reviewComments[0].path).toBe('src/x.ts');
    expect(bundle.issueComments[0].author).toBe('maintainer2');
  });

  it('throws ValidationError on a non-PR URL', async () => {
    const octokit = makeOctokit({});
    await expect(fetchPRCommentBundle(octokit, 'https://github.com/owner/repo/issues/1', 'me')).rejects.toThrow(
      /Invalid PR URL/,
    );
  });

  it('throws ValidationError on a malformed URL', async () => {
    const octokit = makeOctokit({});
    await expect(fetchPRCommentBundle(octokit, 'not-a-url', 'me')).rejects.toThrow(/Invalid PR URL/);
  });

  it("excludes the authenticated user's own comments", async () => {
    const octokit = makeOctokit({
      reviews: [{ user: { login: 'me' }, author_association: 'CONTRIBUTOR', body: 'self review' }],
      reviewComments: [{ user: { login: 'me' }, author_association: 'CONTRIBUTOR', body: 'my own inline' }],
      issueComments: [
        { user: { login: 'me' }, author_association: 'CONTRIBUTOR', body: 'my own thread' },
        { user: { login: 'maintainer1' }, author_association: 'OWNER', body: 'theirs' },
      ],
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.reviews).toHaveLength(0);
    expect(bundle.reviewComments).toHaveLength(0);
    expect(bundle.issueComments).toHaveLength(1);
    expect(bundle.issueComments[0].author).toBe('maintainer1');
  });

  it('compares the user login case-insensitively', async () => {
    const octokit = makeOctokit({
      issueComments: [{ user: { login: 'CostaJohnt' }, author_association: 'CONTRIBUTOR', body: 'mine' }],
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'costajohnt');
    expect(bundle.issueComments).toHaveLength(0);
  });

  it('excludes bot accounts (login containing [bot])', async () => {
    const octokit = makeOctokit({
      issueComments: [
        { user: { login: 'dependabot[bot]' }, author_association: 'NONE', body: 'CI noise' },
        { user: { login: 'maintainer1' }, author_association: 'OWNER', body: 'real' },
      ],
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.issueComments).toHaveLength(1);
    expect(bundle.issueComments[0].author).toBe('maintainer1');
  });

  it('excludes entries with no user (deleted account)', async () => {
    const octokit = makeOctokit({
      issueComments: [
        { user: null, body: 'orphaned' },
        { user: { login: 'maintainer1' }, author_association: 'OWNER', body: 'real' },
      ],
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.issueComments).toHaveLength(1);
    expect(bundle.issueComments[0].author).toBe('maintainer1');
  });

  it('populates authorAssociation on every comment entry', async () => {
    const octokit = makeOctokit({
      reviews: [{ user: { login: 'a' }, author_association: 'MEMBER', body: '' }],
      reviewComments: [{ user: { login: 'b' }, author_association: 'COLLABORATOR', body: '', path: 'x' }],
      issueComments: [{ user: { login: 'c' }, author_association: 'NONE', body: '' }],
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.reviews[0].authorAssociation).toBe('MEMBER');
    expect(bundle.reviewComments[0].authorAssociation).toBe('COLLABORATOR');
    expect(bundle.issueComments[0].authorAssociation).toBe('NONE');
  });

  it("defaults authorAssociation to 'NONE' when GitHub omits it", async () => {
    const octokit = makeOctokit({
      issueComments: [{ user: { login: 'a' }, body: 'x' }], // no author_association
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.issueComments[0].authorAssociation).toBe('NONE');
  });

  it('uses closed_at when merged_at is null (closed without merge)', async () => {
    const octokit = makeOctokit({
      pr: makePR({ merged_at: null, closed_at: '2026-04-19T08:00:00Z' }),
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.mergedAt).toBe('2026-04-19T08:00:00Z');
  });

  it('returns mergedAt as empty string when neither timestamp is set (still-open PR edge case)', async () => {
    const octokit = makeOctokit({
      pr: makePR({ merged_at: null, closed_at: null }),
    });
    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    expect(bundle.mergedAt).toBe('');
  });

  it('paginates real Octokit list responses across page boundaries (#1209 L1)', async () => {
    // 100 reviews on page 1 (== per_page → triggers another page fetch),
    // 1 review on page 2 (< per_page → loop terminates). Verifies the
    // bundle includes items from both pages, catching regressions in the
    // pagination contract that the previous paginateAll mock hid.
    const page1Reviews = Array.from({ length: 100 }, (_, i) => ({
      user: { login: `m${i + 1}` },
      author_association: 'OWNER',
      body: `review ${i + 1}`,
      submitted_at: `2026-04-${String((i % 28) + 1).padStart(2, '0')}T10:00:00Z`,
    }));
    const page2Reviews = [
      {
        user: { login: 'm101' },
        author_association: 'OWNER',
        body: 'final review',
        submitted_at: '2026-04-30T10:00:00Z',
      },
    ];

    const octokit = {
      pulls: {
        get: vi.fn(async () => ({ data: makePR() })),
        listReviews: vi.fn(async (args: { page?: number }) => {
          if (args.page === 1) return { data: page1Reviews };
          if (args.page === 2) return { data: page2Reviews };
          return { data: [] };
        }),
        listReviewComments: vi.fn(async () => ({ data: [] })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
      },
    } as unknown as Octokit;

    const bundle = await fetchPRCommentBundle(octokit, PR_URL, 'me');
    // 101 total reviews — both pages concatenated, none duplicated.
    expect(bundle.reviews).toHaveLength(101);
    expect(bundle.reviews[0].body).toBe('review 1');
    expect(bundle.reviews[100].body).toBe('final review');
    // listReviews called exactly twice — page 1 (full), page 2 (short → stop).
    expect((octokit.pulls.listReviews as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });
});

describe('fetchPRCommentBundlesBatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a bundle per URL when all calls succeed', async () => {
    const octokit = makeOctokit({
      issueComments: [{ user: { login: 'maintainer1' }, author_association: 'OWNER', body: 'feedback' }],
    });
    const urls = [
      'https://github.com/owner/repo/pull/1',
      'https://github.com/owner/repo/pull/2',
      'https://github.com/owner/repo/pull/3',
    ];
    const bundles = await fetchPRCommentBundlesBatch(octokit, urls, 'me');
    expect(bundles).toHaveLength(3);
  });

  it('skips PRs that fail to fetch (404, rate limit) without aborting', async () => {
    let call = 0;
    const octokit = {
      pulls: {
        get: vi.fn(async () => {
          call++;
          if (call === 2) throw new Error('Not Found');
          return { data: makePR() };
        }),
        listReviews: vi.fn(async () => ({ data: [] })),
        listReviewComments: vi.fn(async () => ({ data: [] })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
      },
    } as unknown as Octokit;

    const urls = [
      'https://github.com/owner/repo/pull/1',
      'https://github.com/owner/repo/pull/2',
      'https://github.com/owner/repo/pull/3',
    ];
    const bundles = await fetchPRCommentBundlesBatch(octokit, urls, 'me', 1);
    expect(bundles).toHaveLength(2); // skipped PR 2
  });

  it('respects the concurrency cap', async () => {
    // Manual gate replaces the previous `setTimeout(resolve, 5)` simulated
    // delay (#1209 L2) — no wallclock wait, but still keeps each call
    // in-flight long enough for the parallel workers to bump `maxActive`.
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const octokit = {
      pulls: {
        get: vi.fn(async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => releases.push(resolve));
          active--;
          return { data: makePR() };
        }),
        listReviews: vi.fn(async () => ({ data: [] })),
        listReviewComments: vi.fn(async () => ({ data: [] })),
      },
      issues: {
        listComments: vi.fn(async () => ({ data: [] })),
      },
    } as unknown as Octokit;

    const urls = Array.from({ length: 6 }, (_, i) => `https://github.com/owner/repo/pull/${i + 1}`);
    const batchPromise = fetchPRCommentBundlesBatch(octokit, urls, 'me', 2);
    // Drain all pending workers in lock-step. After each release the freed
    // worker's microtask schedules the next pulls.get; queueMicrotask gives
    // it a chance to land before we pop the next release.
    while (active > 0 || releases.length > 0) {
      const release = releases.shift();
      if (release) release();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
    }
    await batchPromise;
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it('returns [] when given an empty URL list', async () => {
    const octokit = makeOctokit({});
    expect(await fetchPRCommentBundlesBatch(octokit, [], 'me')).toEqual([]);
  });
});

/**
 * `pr-preflight` against real repositories in a temp dir: a bare "upstream",
 * a bare "fork", and a clone with both as remotes. The remotes fetch from the
 * local paths and carry GitHub push URLs, which is what the command parses.
 * GitHub itself is mocked; nothing here reaches the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  getState: vi.fn(),
  reposGet: vi.fn(),
  getBranch: vi.fn(),
  graphql: vi.fn(),
  search: vi.fn(),
}));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: () => ({ getState: mocks.getState }),
    getGitHubTokenAsync: mocks.token,
    requireGitHubToken: () => 'token',
    getOctokit: () => ({
      repos: { get: mocks.reposGet, getBranch: mocks.getBranch },
      graphql: mocks.graphql,
      search: { issuesAndPullRequests: mocks.search },
    }),
  };
});

import { UNATTENDED_ENV } from '../core/errors.js';
import { PrPreflightOutputSchema } from '../formatters/json.js';
import { git } from './overnight-push-prep.js';
import { printPrPreflight, runPrPreflight, type PrPreflightOutput } from './pr-preflight.js';

const IDENTITY = ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false'];
const ISSUE_URL = 'https://github.com/up/proj/issues/7';

const ctx = { tmp: '', upstream: '', fork: '', seed: '', clone: '' };

function commitFile(dir: string, file: string, content: string): void {
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, ['add', '--', file]);
  git(dir, [...IDENTITY, 'commit', '-q', '-m', `change ${file}`]);
}

/** A remote that fetches from a local bare repository and shows a GitHub URL as its push URL. */
function addRemote(name: string, localPath: string, githubRepo: string): void {
  git(ctx.clone, ['remote', 'add', name, localPath]);
  git(ctx.clone, ['remote', 'set-url', '--push', name, `https://github.com/${githubRepo}.git`]);
}

/** Land a commit on upstream main from another clone, without fetching it into the clone under test. */
function advanceUpstream(file: string): string {
  commitFile(ctx.seed, file, `${file} upstream\n`);
  git(ctx.seed, ['push', '-q', 'origin', 'main']);
  return git(ctx.seed, ['rev-parse', 'HEAD']).trim();
}

function upstreamHead(): string {
  return git(ctx.upstream, ['rev-parse', 'main']).trim();
}

function statusOf(data: PrPreflightOutput, id: string): string | undefined {
  return data.checks.find((c) => c.id === id)?.status;
}

function summaryOf(data: PrPreflightOutput, id: string): string {
  return data.checks.find((c) => c.id === id)?.summary ?? '';
}

function issueResponse(linkedAuthor: string | null): unknown {
  const source = {
    number: 9,
    url: 'https://github.com/up/proj/pull/9',
    title: 'Fix crash',
    state: 'OPEN',
    isDraft: false,
    updatedAt: null,
    author: { login: linkedAuthor },
    closingIssuesReferences: { nodes: [{ number: 7, repository: { nameWithOwner: 'up/proj' } }] },
  };
  return {
    viewer: { login: 'me' },
    repository: {
      issue: {
        number: 7,
        title: 'Crash on start',
        url: ISSUE_URL,
        state: 'OPEN',
        stateReason: null,
        closedAt: null,
        assignees: { nodes: [] },
        timelineItems: { nodes: linkedAuthor === null ? [] : [{ source }] },
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  ctx.tmp = fs.realpathSync(made);
  ctx.upstream = path.join(ctx.tmp, 'upstream.git');
  ctx.fork = path.join(ctx.tmp, 'fork.git');
  ctx.seed = path.join(ctx.tmp, 'seed');
  ctx.clone = path.join(ctx.tmp, 'clone');
  git(ctx.tmp, ['init', '-q', '--bare', '-b', 'main', ctx.upstream]);
  git(ctx.tmp, ['init', '-q', '--bare', '-b', 'main', ctx.fork]);
  git(ctx.tmp, ['init', '-q', '-b', 'main', ctx.seed]);
  commitFile(ctx.seed, 'a.txt', 'a\n');
  git(ctx.seed, ['remote', 'add', 'origin', ctx.upstream]);
  git(ctx.seed, ['push', '-q', 'origin', 'main']);

  git(ctx.tmp, ['init', '-q', '-b', 'main', ctx.clone]);
  addRemote('upstream', ctx.upstream, 'up/proj');
  addRemote('origin', ctx.fork, 'me/proj');
  git(ctx.clone, ['fetch', '-q', 'upstream']);
  git(ctx.clone, ['remote', 'set-head', 'upstream', 'main']);
  git(ctx.clone, ['checkout', '-q', '-b', 'fix/thing', 'upstream/main']);
  commitFile(ctx.clone, 'a.txt', 'a fixed\n');

  mocks.token.mockResolvedValue('token');
  mocks.getState.mockReturnValue({
    config: { githubUsername: 'me', maxOpenPRsPerRepo: 2, maxOpenPRsColdRepo: 0, excludeRepos: [] },
    repoScores: {},
    // A merged PR there: not a first contribution, so no recorded policy is a pass.
    mergedPRs: [{ url: 'https://github.com/up/proj/pull/1' }],
  });
  mocks.reposGet.mockResolvedValue({ data: { default_branch: 'main', permissions: { push: false } } });
  mocks.getBranch.mockImplementation(() => Promise.resolve({ data: { commit: { sha: upstreamHead() } } }));
  mocks.search.mockResolvedValue({ data: { total_count: 0 } });
  mocks.graphql.mockResolvedValue(issueResponse(null));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(ctx.tmp, { recursive: true, force: true });
});

describe('runPrPreflight: a ready branch', () => {
  it('passes every check and returns the shape the schema validates', async () => {
    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(PrPreflightOutputSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      verdict: 'pass',
      dir: ctx.clone,
      repo: 'up/proj',
      issueUrl: ISSUE_URL,
      branch: 'fix/thing',
      remote: 'upstream',
      base: 'main',
      mergeBase: upstreamHead(),
      ahead: 1,
      behind: 0,
    });
    expect(data.checks.map((c) => [c.id, c.status])).toEqual([
      ['upstream-drift', 'pass'],
      ['base-branch', 'pass'],
      ['head-branch', 'pass'],
      ['working-tree', 'pass'],
      ['competing-work', 'pass'],
      ['repo-cap', 'pass'],
      ['repo-policy', 'pass'],
    ]);
    expect(mocks.reposGet).toHaveBeenCalledWith({ owner: 'up', repo: 'proj' });
    expect(mocks.getBranch).toHaveBeenCalledWith({ owner: 'up', repo: 'proj', branch: 'main' });
    expect(mocks.search).toHaveBeenCalledWith({ q: 'is:pr is:open author:me repo:up/proj', per_page: 1 });
  });

  it('resolves the working tree root from a subdirectory', async () => {
    const sub = path.join(ctx.clone, 'sub');
    fs.mkdirSync(sub);

    const data = await runPrPreflight({ dir: sub, fetch: false, local: false });

    expect(data.dir).toBe(ctx.clone);
  });

  it('runs in unattended mode: it only reads', async () => {
    vi.stubEnv(UNATTENDED_ENV, '1');

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('pass');
  });

  it('resolves a bare issue number against the upstream remote', async () => {
    const data = await runPrPreflight({ dir: ctx.clone, issue: '#7', fetch: false, local: false });

    expect(data.issueUrl).toBe(ISSUE_URL);
    expect(mocks.graphql).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ number: 7, repo: 'proj' }),
    );
  });
});

describe('runPrPreflight: upstream drift', () => {
  it('reports a stale ref without fetching, then measures the overlap with --fetch', async () => {
    const landed = advanceUpstream('a.txt');
    const before = git(ctx.clone, ['rev-parse', 'upstream/main']).trim();

    const stale = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(stale.verdict).toBe('warn');
    expect(summaryOf(stale, 'upstream-drift')).toContain('upstream/main is stale');
    expect(stale.behind).toBe(0);
    expect(git(ctx.clone, ['rev-parse', 'upstream/main']).trim()).toBe(before);

    const fetched = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    expect(git(ctx.clone, ['rev-parse', 'upstream/main']).trim()).toBe(landed);
    expect(fetched).toMatchObject({ verdict: 'warn', behind: 1, ahead: 1 });
    expect(summaryOf(fetched, 'upstream-drift')).toContain('1 commit(s) on upstream/main');
    const drift = fetched.checks.find((c) => c.id === 'upstream-drift');
    expect(drift?.details?.overlapCount).toBe(1);
    expect(String(drift?.details?.overlappingCommits)).toMatch(
      /^<github-content[^>]*>\n?[0-9a-f]{7} change a\.txt\n?<\/github-content>$/,
    );
  });

  it('passes when upstream moved in files the branch does not touch', async () => {
    advanceUpstream('other.txt');

    const data = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    expect(data).toMatchObject({ verdict: 'pass', behind: 1 });
    expect(summaryOf(data, 'upstream-drift')).toBe(
      "1 commit(s) behind upstream/main, none touching this branch's files",
    );
  });

  it('treats a file name as a literal path, not a pathspec pattern', async () => {
    commitFile(ctx.clone, '*.txt', 'glob\n');
    advanceUpstream('other.txt');

    const data = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    expect(statusOf(data, 'upstream-drift')).toBe('pass');
  });

  it.each(['-x', 'a b.txt', 'new\nline.txt'])('finds the overlap on a file named %j', async (name) => {
    commitFile(ctx.clone, name, 'branch\n');
    advanceUpstream(name);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    const drift = data.checks.find((c) => c.id === 'upstream-drift');
    expect(drift?.status).toBe('warn');
    expect(drift?.details?.overlapCount).toBe(1);
  });

  it('warns when the fetch fails and keeps the other checks', async () => {
    fs.rmSync(ctx.upstream, { recursive: true, force: true });
    mocks.getBranch.mockResolvedValue({ data: { commit: { sha: 'c'.repeat(40) } } });

    const data = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    expect(summaryOf(data, 'upstream-drift')).toContain('git fetch failed');
    expect(statusOf(data, 'base-branch')).toBe('pass');
  });

  it('warns when the target branch was never fetched', async () => {
    mocks.reposGet.mockResolvedValue({ data: { default_branch: 'trunk' } });

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(data).toMatchObject({ base: 'trunk', behind: null, mergeBase: null });
    expect(summaryOf(data, 'upstream-drift')).toBe('upstream/trunk is not fetched locally; run again with --fetch');
    expect(summaryOf(data, 'base-branch')).toContain('now defaults to trunk but the clone records main');
  });
});

describe('runPrPreflight: base and head', () => {
  it('fails when --base names a branch that does not exist upstream', async () => {
    mocks.getBranch.mockRejectedValue(Object.assign(new Error('Branch not found'), { status: 404 }));

    const data = await runPrPreflight({ dir: ctx.clone, base: 'nope', fetch: false, local: false });

    expect(data.verdict).toBe('fail');
    expect(summaryOf(data, 'base-branch')).toBe('branch nope does not exist on up/proj (default branch: main)');
    expect(mocks.getBranch).toHaveBeenCalledWith({ owner: 'up', repo: 'proj', branch: 'nope' });
  });

  it('keeps the local checks when the repository read fails', async () => {
    mocks.getBranch.mockRejectedValue(Object.assign(new Error('rate limited'), { status: 403 }));

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(summaryOf(data, 'base-branch')).toBe('GitHub request failed: rate limited; local guess: main');
    expect(data).toMatchObject({ base: 'main', behind: 0, ahead: 1 });
    expect(statusOf(data, 'upstream-drift')).toBe('pass');
    expect(statusOf(data, 'competing-work')).toBe('pass');
  });

  it('fails on a detached HEAD', async () => {
    git(ctx.clone, ['checkout', '-q', '--detach']);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(data).toMatchObject({ verdict: 'fail', branch: null });
    expect(statusOf(data, 'head-branch')).toBe('fail');
  });

  it('fails on the default branch and warns on a dirty tree', async () => {
    git(ctx.clone, ['checkout', '-q', '-b', 'main', 'upstream/main']);
    fs.writeFileSync(path.join(ctx.clone, 'new.txt'), 'new\n');

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(statusOf(data, 'head-branch')).toBe('fail');
    expect(summaryOf(data, 'working-tree')).toContain('1 uncommitted change(s)');
  });

  it('in a fork-only clone behind upstream, reports the missing remote instead of a stale ref', async () => {
    git(ctx.seed, ['push', '-q', ctx.fork, 'main']);
    advanceUpstream('other.txt');
    git(ctx.clone, ['remote', 'remove', 'upstream']);
    git(ctx.clone, ['fetch', '-q', 'origin']);

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: true, local: false });

    expect(data).toMatchObject({ repo: 'up/proj', remote: 'origin', behind: 0 });
    expect(summaryOf(data, 'upstream-drift')).toBe(
      'no remote points at up/proj, so drift was measured against origin/main instead (0 behind); add a remote for up/proj',
    );
    expect(statusOf(data, 'upstream-drift')).toBe('warn');
  });

  it('warns when the user has no fork remote and cannot push upstream', async () => {
    git(ctx.clone, ['remote', 'remove', 'origin']);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(summaryOf(data, 'head-branch')).toContain('no remote is owned by me');
  });
});

describe('runPrPreflight: competing work and repo cap', () => {
  it('fails when someone else has an open PR that closes the issue', async () => {
    mocks.graphql.mockResolvedValue(issueResponse('rival'));

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('fail');
    expect(summaryOf(data, 'competing-work')).toContain('taken: open PR by rival');
  });

  it('warns when the open closing PR is the user own', async () => {
    mocks.graphql.mockResolvedValue(issueResponse('me'));

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('warn');
    expect(statusOf(data, 'competing-work')).toBe('warn');
  });

  it('skips the cap check, not the whole gate, when the username is not configured', async () => {
    mocks.getState.mockReturnValue({
      config: { githubUsername: '' },
      repoScores: {},
      mergedPRs: [{ url: 'https://github.com/up/proj/pull/1' }],
    });

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(statusOf(data, 'repo-cap')).toBe('skipped');
    expect(statusOf(data, 'competing-work')).toBe('pass');
    expect(statusOf(data, 'head-branch')).toBe('warn');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('warns when the issue could not be verified and keeps every other check', async () => {
    mocks.graphql.mockRejectedValue(new Error('socket hang up'));

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('warn');
    expect(summaryOf(data, 'competing-work')).toContain('could not verify the issue (socket hang up)');
    expect(statusOf(data, 'base-branch')).toBe('pass');
    expect(statusOf(data, 'repo-cap')).toBe('pass');
  });

  it('skips the cap check when its search fails and keeps every other check', async () => {
    mocks.search.mockRejectedValue(new Error('secondary rate limit'));

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('pass');
    expect(summaryOf(data, 'repo-cap')).toBe('GitHub request failed: secondary rate limit');
    expect(statusOf(data, 'competing-work')).toBe('pass');
  });

  it('still rejects an issue that does not exist', async () => {
    mocks.graphql.mockResolvedValue({ viewer: { login: 'me' }, repository: { issue: null } });

    await expect(runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false })).rejects.toThrow(
      /Issue not found/,
    );
  });

  it('runs the cap check only for an issue', async () => {
    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(summaryOf(data, 'repo-cap')).toBe('no issue given (the cap gates a new PR)');
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('warns at the open-PR cap', async () => {
    mocks.search.mockResolvedValue({ data: { total_count: 2 } });

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data.verdict).toBe('warn');
    expect(summaryOf(data, 'repo-cap')).toContain('at the cap of 2');
  });
});

describe('runPrPreflight: without GitHub', () => {
  it('runs the local checks and skips the network checks without a token', async () => {
    mocks.token.mockResolvedValue(null);

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: false });

    expect(data).toMatchObject({ verdict: 'pass', base: 'main', behind: 0, ahead: 1 });
    expect(data.checks.map((c) => [c.id, c.status])).toEqual([
      ['upstream-drift', 'pass'],
      ['base-branch', 'skipped'],
      ['head-branch', 'pass'],
      ['working-tree', 'pass'],
      ['competing-work', 'skipped'],
      ['repo-cap', 'skipped'],
      ['repo-policy', 'pass'],
    ]);
    expect(summaryOf(data, 'repo-cap')).toContain('no GitHub token');
    expect(mocks.reposGet).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('--local makes no GitHub read and still measures the branch', async () => {
    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: true, local: true });

    expect(data).toMatchObject({ verdict: 'pass', base: 'main', behind: 0, ahead: 1, mergeBase: upstreamHead() });
    expect(summaryOf(data, 'base-branch')).toBe('local mode (--local); local guess: main');
    expect(summaryOf(data, 'competing-work')).toBe('local mode (--local)');
    expect(summaryOf(data, 'repo-cap')).toBe('local mode (--local)');
    expect(mocks.token).not.toHaveBeenCalled();
    expect(mocks.reposGet).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it('--local falls back to the default branch origin records when the upstream remote has no HEAD', async () => {
    git(ctx.clone, ['remote', 'set-head', 'upstream', '--delete']);
    git(ctx.seed, ['push', '-q', ctx.fork, 'main']);
    git(ctx.clone, ['fetch', '-q', 'origin']);
    git(ctx.clone, ['remote', 'set-head', 'origin', 'main']);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: true });

    expect(data).toMatchObject({ remote: 'upstream', base: 'main', ahead: 1 });
  });

  it('skips the network checks when no remote is a GitHub repository', async () => {
    git(ctx.clone, ['remote', 'set-url', '--push', 'upstream', ctx.upstream]);
    git(ctx.clone, ['remote', 'remove', 'origin']);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: false, local: false });

    expect(data).toMatchObject({ repo: null, remote: 'upstream', behind: 0 });
    expect(summaryOf(data, 'base-branch')).toBe('no remote points at a GitHub repository; local guess: main');
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it('warns when the clone has no remote at all', async () => {
    git(ctx.clone, ['remote', 'remove', 'upstream']);
    git(ctx.clone, ['remote', 'remove', 'origin']);

    const data = await runPrPreflight({ dir: ctx.clone, fetch: true, local: false });

    expect(data).toMatchObject({ verdict: 'warn', remote: null, base: null });
    expect(summaryOf(data, 'upstream-drift')).toBe('no git remote to compare against');
  });
});

describe('runPrPreflight: input validation', () => {
  it('rejects a directory that is not a git working tree', async () => {
    await expect(runPrPreflight({ dir: ctx.tmp, fetch: false, local: false })).rejects.toThrow(
      /Not a git working tree/,
    );
  });

  it('rejects a base branch that looks like an option', async () => {
    await expect(
      runPrPreflight({ dir: ctx.clone, base: '--upload-pack=x', fetch: true, local: false }),
    ).rejects.toThrow(/Invalid base branch name/);
  });

  it('rejects a pull request URL as the issue', async () => {
    const pr = 'https://github.com/up/proj/pull/9';
    await expect(runPrPreflight({ dir: ctx.clone, issue: pr, fetch: false, local: false })).rejects.toThrow(
      /Invalid issue URL/,
    );
  });

  it('rejects an issue number when no remote names a GitHub repository', async () => {
    git(ctx.clone, ['remote', 'remove', 'upstream']);
    git(ctx.clone, ['remote', 'remove', 'origin']);

    await expect(runPrPreflight({ dir: ctx.clone, issue: '7', fetch: false, local: false })).rejects.toThrow(
      /pass the issue URL/,
    );
  });
});

describe('runPrPreflight: repo contribution policy (#1953)', () => {
  it('fails for a repo in aiPolicyBlocklist, whatever is stored', async () => {
    mocks.getState.mockReturnValue({
      config: { githubUsername: 'me', excludeRepos: [], aiPolicyBlocklist: ['Up/Proj'] },
      repoScores: {},
      mergedPRs: [{ url: 'https://github.com/up/proj/pull/1' }],
      repoPolicies: {
        'up/proj': {
          aiPolicy: 'allowed',
          cla: 'none',
          commitRules: [],
          prGate: 'none',
          source: [],
          reviewedByUser: true,
          updatedAt: '2026-11-01T00:00:00.000Z',
        },
      },
    });

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: true });

    expect(data.verdict).toBe('fail');
    expect(statusOf(data, 'repo-policy')).toBe('fail');
    expect(summaryOf(data, 'repo-policy')).toContain('does not accept AI-assisted contributions');
  });

  it('warns on a first contribution with no recorded policy', async () => {
    mocks.getState.mockReturnValue({ config: { githubUsername: 'me', excludeRepos: [] }, repoScores: {} });

    const data = await runPrPreflight({ dir: ctx.clone, issue: ISSUE_URL, fetch: false, local: true });

    expect(statusOf(data, 'repo-policy')).toBe('warn');
    expect(summaryOf(data, 'repo-policy')).toContain('policy set --repo up/proj');
  });
});

describe('printPrPreflight', () => {
  it('prints the verdict and one line per check', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    git(ctx.clone, ['checkout', '-q', '--detach']);

    printPrPreflight(await runPrPreflight({ dir: ctx.clone, fetch: false, local: false }));

    const lines = log.mock.calls.map((call) => String(call[0]));
    expect(lines[0]).toBe('\nPR preflight: FAIL  (detached HEAD) -> up/proj:main');
    expect(lines).toContain('  [fail] head-branch: detached HEAD: check out a feature branch before opening a PR');
    expect(lines).toHaveLength(8);
  });
});

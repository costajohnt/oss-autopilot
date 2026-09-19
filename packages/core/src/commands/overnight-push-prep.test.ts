/**
 * Tests for `overnight push-prep` (#1698): remote-owner resolution, the
 * non-fork refusal, the prep/ namespace gate, non-fast-forward handling, and
 * the state/report round trip. git and GitHub are mocked; nothing here
 * touches the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    getOctokit: vi.fn(),
    requireGitHubToken: () => 'tok',
    maybeCheckpoint: vi.fn().mockResolvedValue(null),
  };
});

import { getOctokit, getStateManager, maybeCheckpoint } from '../core/index.js';
import {
  PREP_REF_PREFIX,
  PrepNamespaceError,
  buildPrepRef,
  compareUrlFor,
  parseRemoteOwner,
  parseRemotesOutput,
  prepBranchName,
  resolvePushRemote,
  runOvernightPushPrep,
} from './overnight-push-prep.js';
import type { OvernightPrepared, OvernightRecord } from '../core/types.js';
import { OvernightPreparedSchema } from '../core/state-schema.js';

const mockExecFileSync = vi.mocked(execFileSync);
const mockGetStateManager = vi.mocked(getStateManager);
const mockGetOctokit = vi.mocked(getOctokit);
const mockCheckpoint = vi.mocked(maybeCheckpoint);

let tmp = '';

function fakeStateManager(initial: OvernightRecord | undefined, githubUsername = 'Octocat') {
  let last = initial;
  return {
    getLastOvernight: () => last,
    setLastOvernight: vi.fn((r: OvernightRecord) => {
      last = r;
    }),
    getState: () => ({ config: { githubUsername } }),
  } as unknown as ReturnType<typeof getStateManager> & { setLastOvernight: ReturnType<typeof vi.fn> };
}

function fakeOctokit(opts: { login?: string; fork?: boolean; head?: string; repoError?: Error } = {}) {
  const octokit = {
    users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: opts.login ?? 'octocat' } }) },
    repos: {
      get: opts.repoError
        ? vi.fn().mockRejectedValue(opts.repoError)
        : vi.fn().mockResolvedValue({
            data: { fork: opts.fork ?? true, owner: { login: opts.login ?? 'octocat' }, full_name: 'octocat/react' },
          }),
    },
    pulls: { get: vi.fn().mockResolvedValue({ data: { head: { ref: opts.head ?? 'fix-lint' } } }) },
  };
  mockGetOctokit.mockReturnValue(octokit as never);
  return octokit;
}

/** `git remote -v` answers with `remotes`; `git push` answers with `push` (a string) or throws it (an Error). */
function fakeGit(remotes: string, push: string | Error = '') {
  mockExecFileSync.mockImplementation(((_cmd: string, args: string[]) => {
    if (args[2] === 'remote') return remotes;
    if (args[2] === 'push') {
      if (push instanceof Error) throw push;
      return push;
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  }) as never);
}

const forkRemotes =
  'origin\thttps://github.com/OctoCat/react.git (fetch)\norigin\thttps://github.com/OctoCat/react.git (push)\nupstream\thttps://github.com/facebook/react.git (fetch)\nupstream\thttps://github.com/facebook/react.git (push)\n';

function entry(over: Partial<OvernightPrepared> = {}): OvernightPrepared {
  return {
    url: 'https://github.com/facebook/react/pull/42',
    branch: 'overnight/42-2026-09-18',
    worktree: tmp,
    recordedAt: 'x',
    ...over,
  };
}

function record(prepared: OvernightPrepared[]): OvernightRecord {
  return { runAt: 'now', reportPath: path.join(tmp, 'r.md'), prepareCount: 1, judgmentCount: 0, prepared };
}

function pushCalls(): string[][] {
  return mockExecFileSync.mock.calls.filter((c) => (c[1] as string[])[2] === 'push').map((c) => c[1] as string[]);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-prep-'));
  vi.clearAllMocks();
  mockCheckpoint.mockResolvedValue(null);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('parseRemoteOwner', () => {
  it.each([
    ['https://github.com/octocat/react.git', 'octocat', 'react'],
    ['https://github.com/octocat/react', 'octocat', 'react'],
    ['https://github.com/octocat/react/', 'octocat', 'react'],
    ['https://user@github.com/octocat/next.js.git', 'octocat', 'next.js'],
    ['git@github.com:OctoCat/react.git', 'OctoCat', 'react'],
    ['git@github.com:octocat/react', 'octocat', 'react'],
    ['ssh://git@github.com/octocat/react.git', 'octocat', 'react'],
    ['ssh://git@github.com:22/octocat/react.git', 'octocat', 'react'],
    ['https://GitHub.com/octocat/react.git', 'octocat', 'react'],
  ])('%s -> %s/%s', (url, owner, repo) => {
    expect(parseRemoteOwner(url)).toEqual({ owner, repo });
  });

  it.each([
    'https://gitlab.com/octocat/react.git',
    'https://github.com/octocat',
    'https://github.com/octocat/react/pull/1',
    'https://evil.example/github.com/octocat/react.git',
    'git@github.com:octocat/re po.git',
    '',
  ])('rejects %s', (url) => {
    expect(parseRemoteOwner(url)).toBeNull();
  });
});

describe('parseRemotesOutput', () => {
  it('keeps one push URL per remote', () => {
    expect(parseRemotesOutput(forkRemotes)).toEqual([
      { name: 'origin', url: 'https://github.com/OctoCat/react.git' },
      { name: 'upstream', url: 'https://github.com/facebook/react.git' },
    ]);
    expect(parseRemotesOutput('')).toEqual([]);
  });
});

describe('resolvePushRemote', () => {
  it('matches the parsed owner case-insensitively over https and ssh, ignoring remote names', () => {
    const remotes = [
      { name: 'origin', url: 'https://github.com/facebook/react.git' },
      { name: 'mine', url: 'git@github.com:OCTOCAT/react.git' },
    ];
    expect(resolvePushRemote(remotes, 'octocat')).toEqual({ remote: 'mine', owner: 'OCTOCAT', repo: 'react' });
    expect(resolvePushRemote(parseRemotesOutput(forkRemotes), 'octocat')?.remote).toBe('origin');
  });

  it('never matches by substring, prefix, or remote name', () => {
    const remotes = [
      { name: 'octocat', url: 'https://github.com/facebook/react.git' },
      { name: 'origin', url: 'https://github.com/octocat-mirror/react.git' },
      { name: 'other', url: 'https://github.com/notoctocat/react.git' },
      { name: 'gitlab', url: 'https://gitlab.com/octocat/react.git' },
    ];
    expect(resolvePushRemote(remotes, 'octocat')).toBeNull();
  });

  it('never picks a remote whose name looks like an option', () => {
    const remotes = [
      { name: '--force', url: 'https://github.com/octocat/react.git' },
      { name: '-f', url: 'https://github.com/octocat/react.git' },
    ];
    expect(resolvePushRemote(remotes, 'octocat')).toBeNull();
  });
});

describe('buildPrepRef', () => {
  it('always lands under refs/heads/prep/', () => {
    expect(buildPrepRef('overnight/42-2026-09-18')).toBe('refs/heads/prep/overnight/42-2026-09-18');
    expect(buildPrepRef('main')).toBe(`${PREP_REF_PREFIX}main`);
    expect(prepBranchName(buildPrepRef('x'))).toBe('prep/x');
  });

  it.each([
    '',
    '/main',
    'main/',
    'a//b',
    '../refs/heads/main',
    'a..b',
    'a b',
    'a:b',
    'a~1',
    'a^',
    'a?',
    'a*',
    'a[b',
    'a\\b',
    'a@{1}',
    'a.lock',
    'a\nb',
  ])('refuses %j', (branch) => {
    expect(() => buildPrepRef(branch)).toThrow(/not a valid ref name/);
  });

  it('prepBranchName rejects a ref outside the namespace as a programming error', () => {
    expect(() => prepBranchName('refs/heads/main')).toThrow(PrepNamespaceError);
    expect(() => prepBranchName(PREP_REF_PREFIX)).toThrow(PrepNamespaceError);
  });
});

describe('compareUrlFor', () => {
  it('points at the fork with the PR head on the left', () => {
    expect(compareUrlFor({ owner: 'octocat', repo: 'react' }, 'fix-lint', 'prep/overnight/42')).toBe(
      'https://github.com/octocat/react/compare/fix-lint...prep/overnight/42',
    );
  });
});

describe('runOvernightPushPrep', () => {
  it('refuses before any run', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(undefined));
    fakeOctokit();
    await expect(runOvernightPushPrep({ dryRun: true })).rejects.toThrow(/run `overnight` first/);
  });

  it('refuses when the configured username and the token login disagree', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry()]), 'someone-else'));
    fakeOctokit({ login: 'octocat' });
    await expect(runOvernightPushPrep({ dryRun: false })).rejects.toThrow(/does not match the token's login/);
    expect(pushCalls()).toEqual([]);
  });

  it('pushes HEAD to prep/<branch> on the fork remote, never with --force, and records the ref', async () => {
    const reportPath = path.join(tmp, 'r.md');
    fs.writeFileSync(reportPath, '# H\n\n## Prepared branches (1)\n\n- old\n\n## Needs your judgment (0)\n');
    const sm = fakeStateManager(record([entry()]));
    mockGetStateManager.mockReturnValue(sm);
    const octokit = fakeOctokit({ login: 'octocat', fork: true, head: 'fix-lint' });
    fakeGit(forkRemotes);
    mockCheckpoint.mockResolvedValueOnce('push failed');

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.login).toBe('octocat');
    expect(out.pushed).toBe(1);
    expect(out.skipped).toBe(0);
    expect(out.gistSyncWarning).toBe('push failed');
    expect(out.results[0]).toEqual({
      url: 'https://github.com/facebook/react/pull/42',
      branch: 'overnight/42-2026-09-18',
      status: 'pushed',
      remote: 'origin',
      repo: 'OctoCat/react',
      ref: 'refs/heads/prep/overnight/42-2026-09-18',
      compareUrl: 'https://github.com/OctoCat/react/compare/fix-lint...prep/overnight/42-2026-09-18',
    });
    expect(pushCalls()).toEqual([
      [
        '-C',
        tmp,
        'push',
        '--no-follow-tags',
        '--',
        'origin',
        'refs/heads/overnight/42-2026-09-18:refs/heads/prep/overnight/42-2026-09-18',
      ],
    ]);
    for (const args of pushCalls()) expect(args.join(' ')).not.toMatch(/--force|\+refs/);
    expect(octokit.repos.get).toHaveBeenCalledWith({ owner: 'OctoCat', repo: 'react' });
    expect(octokit.pulls.get).toHaveBeenCalledWith({ owner: 'facebook', repo: 'react', pull_number: 42 });

    const saved = sm.getLastOvernight()!.prepared[0];
    expect(saved.pushedRef).toBe('prep/overnight/42-2026-09-18');
    expect(saved.compareUrl).toBe(out.results[0].compareUrl);
    expect(saved.pushedAt).toMatch(/^\d{4}-/);
    expect(OvernightPreparedSchema.parse(saved)).toEqual(saved);
    expect(sm.setLastOvernight.mock.invocationCallOrder[0]).toBeLessThan(mockCheckpoint.mock.invocationCallOrder[0]);
    const md = fs.readFileSync(reportPath, 'utf8');
    expect(md).toContain('## Prepared branches (1)');
    expect(md).toContain(
      '(pushed to `prep/overnight/42-2026-09-18`, compare https://github.com/OctoCat/react/compare/fix-lint...prep/overnight/42-2026-09-18)',
    );
    expect(md).toContain('## Needs your judgment (0)');
  });

  it('re-run is idempotent: same ref, same state shape, one report line, still no force', async () => {
    const reportPath = path.join(tmp, 'r.md');
    fs.writeFileSync(reportPath, '# H\n\n## Prepared branches (0)\n\n_None recorded yet._\n');
    const sm = fakeStateManager(record([entry()]));
    mockGetStateManager.mockReturnValue(sm);
    fakeOctokit();
    fakeGit(forkRemotes);

    const first = await runOvernightPushPrep({ dryRun: false });
    const firstSaved = sm.getLastOvernight()!.prepared[0];
    const second = await runOvernightPushPrep({ dryRun: false });
    const secondSaved = sm.getLastOvernight()!.prepared[0];

    expect(second.results).toEqual(first.results);
    expect({ ...secondSaved, pushedAt: undefined }).toEqual({ ...firstSaved, pushedAt: undefined });
    expect(pushCalls()).toHaveLength(2);
    expect(new Set(pushCalls().map((c) => c.join(' '))).size).toBe(1);
    expect(sm.getLastOvernight()!.prepared).toHaveLength(1);
    const md = fs.readFileSync(reportPath, 'utf8');
    expect(md.match(/pushed to `prep\//g)).toHaveLength(1);
  });

  it('--dry-run resolves the plan and touches neither git push, state, nor the report', async () => {
    const reportPath = path.join(tmp, 'r.md');
    fs.writeFileSync(reportPath, 'untouched');
    const sm = fakeStateManager(record([entry()]));
    mockGetStateManager.mockReturnValue(sm);
    fakeOctokit();
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: true });

    expect(out.dryRun).toBe(true);
    expect(out.planned).toBe(1);
    expect(out.results[0].status).toBe('planned');
    expect(out.results[0].ref).toBe('refs/heads/prep/overnight/42-2026-09-18');
    expect(pushCalls()).toEqual([]);
    expect(sm.setLastOvernight).not.toHaveBeenCalled();
    expect(mockCheckpoint).not.toHaveBeenCalled();
    expect(fs.readFileSync(reportPath, 'utf8')).toBe('untouched');
    expect(out).not.toHaveProperty('gistSyncWarning');
  });

  it('refuses a remote that is not a fork', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry()])));
    fakeOctokit({ fork: false });
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.skipped).toBe(1);
    expect(out.results[0]).toMatchObject({
      status: 'skipped',
      remote: 'origin',
      reason: 'OctoCat/react is not a fork',
    });
    expect(pushCalls()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, 'r.md'))).toBe(true);
  });

  it('refuses a fork the login does not own (a transferred repo behind a stale URL)', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry()])));
    const octokit = fakeOctokit();
    octokit.repos.get.mockResolvedValue({
      data: { fork: true, owner: { login: 'some-org' }, full_name: 'some-org/react' },
    });
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({
      status: 'skipped',
      reason: 'OctoCat/react resolved to some-org/react, not owned by octocat',
    });
    expect(pushCalls()).toEqual([]);
  });

  it('skips when the fork lookup fails rather than guessing', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry()])));
    fakeOctokit({ repoError: new Error('Not Found') });
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0].status).toBe('skipped');
    expect(out.results[0].reason).toMatch(/could not read OctoCat\/react: Not Found/);
    expect(pushCalls()).toEqual([]);
  });

  it('skips when no remote is owned by the login, when no worktree was recorded, and when it is gone', async () => {
    const gone = path.join(tmp, 'gone');
    mockGetStateManager.mockReturnValue(
      fakeStateManager(
        record([
          entry({ branch: 'a' }),
          entry({ branch: 'b', worktree: undefined }),
          entry({ branch: 'c', worktree: gone }),
        ]),
      ),
    );
    const octokit = fakeOctokit();
    fakeGit('upstream\thttps://github.com/facebook/react.git (push)\n');

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results.map((r) => [r.branch, r.status, r.reason])).toEqual([
      ['a', 'skipped', `no remote in ${tmp} is owned by octocat`],
      ['b', 'skipped', 'no worktree recorded'],
      ['c', 'skipped', `worktree ${gone} does not exist`],
    ]);
    expect(out.skipped).toBe(3);
    expect(octokit.repos.get).not.toHaveBeenCalled();
    expect(pushCalls()).toEqual([]);
  });

  it('a non-fast-forward is a skip with a reason, never a retry with --force', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry()])));
    fakeOctokit();
    const rejected = Object.assign(new Error('Command failed: git push'), {
      stderr:
        ' ! [rejected]        HEAD -> prep/overnight/42-2026-09-18 (non-fast-forward)\nerror: failed to push some refs\n',
    });
    fakeGit(forkRemotes, rejected);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({
      status: 'skipped',
      ref: 'refs/heads/prep/overnight/42-2026-09-18',
      reason: 'non-fast-forward: prep/overnight/42-2026-09-18 on origin has commits this worktree lacks; not forced',
    });
    expect(pushCalls()).toHaveLength(1);
    expect(pushCalls()[0].join(' ')).not.toContain('force');
    expect(mockGetStateManager().getLastOvernight()!.prepared[0]).not.toHaveProperty('pushedRef');
  });

  it('any other push failure is a skip with the git error, and other entries still proceed', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry({ branch: 'a' }), entry({ branch: 'b' })])));
    fakeOctokit();
    let calls = 0;
    mockExecFileSync.mockImplementation(((_cmd: string, args: string[]) => {
      if (args[2] === 'remote') return forkRemotes;
      if (++calls === 1) throw Object.assign(new Error('boom'), { stderr: 'fatal: unable to access' });
      return '';
    }) as never);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results.map((r) => r.status)).toEqual(['skipped', 'pushed']);
    expect(out.results[0].reason).toMatch(/^push failed: boom/);
  });

  it('an invalid branch name is a skip, and the fork verdict is fetched once per repo', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager(record([entry({ branch: 'a..b' }), entry({ branch: 'ok' })])));
    const octokit = fakeOctokit();
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/not a valid ref name/) });
    expect(out.results[1].status).toBe('pushed');
    expect(octokit.repos.get).toHaveBeenCalledTimes(1);
  });

  it('still pushes when the PR head cannot be read, just without a compare URL', async () => {
    mockGetStateManager.mockReturnValue(
      fakeStateManager(record([entry({ url: 'https://github.com/facebook/react/issues/7' })])),
    );
    fakeOctokit();
    fakeGit(forkRemotes);

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0].status).toBe('pushed');
    expect(out.results[0]).not.toHaveProperty('compareUrl');
    expect(mockGetStateManager().getLastOvernight()!.prepared[0]).not.toHaveProperty('compareUrl');
  });
});

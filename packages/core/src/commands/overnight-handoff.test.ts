/**
 * The overnight handoff: a tick running as a user with no write-capable
 * GitHub credential leaves bundles and a state file in a drop dir, and
 * `overnight push-prep`, running as the user that holds the token, pushes
 * from a private repo it fills from those bundles. Real git end to end; the
 * "fork" is a local bare repo reached through a url.insteadOf rewrite, and
 * GitHub itself is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

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
vi.mock('../core/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../core/paths.js')>('../core/paths.js');
  return { ...actual, getReportsDir: vi.fn() };
});

import { getOctokit, getStateManager } from '../core/index.js';
import { getReportsDir } from '../core/paths.js';
import type { OvernightRecord } from '../core/types.js';
import { HANDOFF_ENV, HANDOFF_STATE, bundleFileFor, exportHandoff, writeHandoffBundle } from './overnight-handoff.js';
import { runOvernightPushPrep } from './overnight-push-prep.js';
import { runOvernightRecord } from './overnight.js';

const BRANCH = 'overnight/42-2026-09-22';
const PR_URL = 'https://github.com/facebook/react/pull/42';

let tmp = '';
let drop = '';
let fork = '';
let marker = '';
const savedEnv = { ...process.env };

function run(args: string[], cwd?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** The tick's clone: one commit on BRANCH, plus a planted pre-push hook and fsmonitor that would touch `marker`. */
function tickClone(): { dir: string; sha: string } {
  const dir = path.join(tmp, 'tick-clone');
  run(['init', '-q', '-b', 'main', dir]);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'fix\n');
  run(['add', 'a.txt'], dir);
  run(['commit', '-q', '-m', 'fix'], dir);
  run(['branch', BRANCH], dir);
  const evil = `#!/bin/sh\ntouch '${marker}'\n`;
  fs.writeFileSync(path.join(dir, '.git', 'hooks', 'pre-push'), evil, { mode: 0o755 });
  fs.writeFileSync(path.join(tmp, 'fsmonitor.sh'), evil, { mode: 0o755 });
  run(['config', 'core.fsmonitor', path.join(tmp, 'fsmonitor.sh')], dir);
  run(['config', 'core.hooksPath', path.join(dir, '.git', 'hooks')], dir);
  return { dir, sha: run(['rev-parse', BRANCH], dir) };
}

function fakeStateManager(initial?: OvernightRecord) {
  let last = initial;
  return {
    getLastOvernight: () => last,
    setLastOvernight: vi.fn((r: OvernightRecord) => {
      last = r;
    }),
    getState: () => ({ config: { githubUsername: 'octocat' } }),
    isGistMode: () => true,
    setOvernightReportDocument: vi.fn(),
  };
}

function fakeOctokit(opts: { headOwner?: string; parent?: string; fork?: boolean } = {}) {
  const octokit = {
    users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'octocat' } }) },
    repos: {
      get: vi.fn().mockImplementation(({ owner, repo }: { owner: string; repo: string }) =>
        Promise.resolve({
          data: {
            fork: opts.fork ?? true,
            owner: { login: owner },
            full_name: `${owner}/${repo}`,
            parent: { full_name: opts.parent ?? 'facebook/react' },
          },
        }),
      ),
    },
    pulls: {
      get: vi.fn().mockResolvedValue({
        data: {
          head: {
            ref: 'fix-lint',
            repo: {
              name: 'react',
              full_name: `${opts.headOwner ?? 'octocat'}/react`,
              owner: { login: opts.headOwner ?? 'octocat' },
            },
          },
        },
      }),
    },
  };
  vi.mocked(getOctokit).mockReturnValue(octokit as never);
  return octokit;
}

function handoffRecord(over: Partial<OvernightRecord['prepared'][number]> = {}): OvernightRecord {
  return {
    runAt: '2026-09-22T09:30:00.000Z',
    reportPath: '/home/agent-ro/.oss-autopilot/reports/overnight-2026-09-22.md',
    prepareCount: 1,
    judgmentCount: 2,
    prepared: [{ url: PR_URL, branch: BRANCH, worktree: '/home/agent-ro/wt', recordedAt: 'x', ...over }],
  };
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-')));
  drop = path.join(tmp, 'drop');
  fs.mkdirSync(drop);
  fs.mkdirSync(path.join(tmp, 'reports'));
  marker = path.join(tmp, 'PLANTED-CODE-RAN');
  fork = path.join(tmp, 'fork.git');
  run(['init', '-q', '--bare', fork]);
  vi.clearAllMocks();
  vi.mocked(getReportsDir).mockReturnValue(path.join(tmp, 'reports'));
  Object.assign(process.env, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'user.name',
    GIT_CONFIG_VALUE_0: 'Test',
    GIT_CONFIG_KEY_1: 'user.email',
    GIT_CONFIG_VALUE_1: 'test@example.com',
    // Every push to the fork lands in the local bare repo instead.
    GIT_CONFIG_KEY_2: `url.${fork}.insteadOf`,
    GIT_CONFIG_VALUE_2: 'https://github.com/octocat/react.git',
    [HANDOFF_ENV]: drop,
  });
});

afterEach(() => {
  process.env = { ...savedEnv };
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('tick side', () => {
  it('writes a bundle holding the branch, and a state file without local paths', () => {
    const { dir, sha } = tickClone();
    writeHandoffBundle(drop, dir, BRANCH);
    const bundle = path.join(drop, bundleFileFor(BRANCH));
    expect(run(['bundle', 'list-heads', bundle])).toBe(`${sha} refs/heads/${BRANCH}`);
    expect(fs.statSync(bundle).mode & 0o777).toBe(0o640);

    fs.writeFileSync(path.join(tmp, 'report.md'), '# report\n');
    exportHandoff(drop, { ...handoffRecord(), reportPath: path.join(tmp, 'report.md') });
    const saved = JSON.parse(fs.readFileSync(path.join(drop, HANDOFF_STATE), 'utf8'));
    expect(saved.prepared[0].worktree).toBeUndefined();
    expect(fs.readFileSync(path.join(drop, 'report.md'), 'utf8')).toBe('# report\n');
  });

  it('overnight record bundles the branch before recording it', async () => {
    const { dir, sha } = tickClone();
    const sm = fakeStateManager({ ...handoffRecord(), prepared: [], reportPath: path.join(tmp, 'r.md') });
    vi.mocked(getStateManager).mockReturnValue(sm as never);

    await runOvernightRecord({ url: PR_URL, branch: BRANCH, worktree: dir });

    expect(run(['bundle', 'list-heads', path.join(drop, bundleFileFor(BRANCH))])).toBe(`${sha} refs/heads/${BRANCH}`);
    const saved = JSON.parse(fs.readFileSync(path.join(drop, HANDOFF_STATE), 'utf8'));
    expect(saved.prepared).toEqual([expect.objectContaining({ url: PR_URL, branch: BRANCH })]);
  });

  it('overnight record refuses a branch it cannot bundle', async () => {
    const sm = fakeStateManager({ ...handoffRecord(), prepared: [], reportPath: path.join(tmp, 'r.md') });
    vi.mocked(getStateManager).mockReturnValue(sm as never);

    await expect(runOvernightRecord({ url: PR_URL, branch: BRANCH })).rejects.toThrow(/No worktree to bundle/);
    expect(sm.setLastOvernight).not.toHaveBeenCalled();
  });

  it('bundle file names stay inside the drop dir', () => {
    expect(bundleFileFor('overnight/../../x')).not.toContain('/');
  });

  it('bundle file names are distinct for branches that sanitize to the same stem', () => {
    expect(bundleFileFor('fix/x')).not.toBe(bundleFileFor('fix_x'));
  });
});

/** What the tick leaves behind: one bundled branch, the state file and a report. */
function stage(over: Partial<OvernightRecord['prepared'][number]> = {}): string {
  const { dir, sha } = tickClone();
  writeHandoffBundle(drop, dir, BRANCH);
  fs.writeFileSync(path.join(tmp, 'tick-report.md'), '# Overnight\n');
  exportHandoff(drop, { ...handoffRecord(over), reportPath: path.join(tmp, 'tick-report.md') });
  return sha;
}

describe('push-prep from the handoff', () => {
  it("pushes the bundle's branch to prep/* without running anything the tick planted", async () => {
    const sha = stage();
    const sm = fakeStateManager();
    vi.mocked(getStateManager).mockReturnValue(sm as never);
    fakeOctokit();

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results).toEqual([
      expect.objectContaining({ status: 'pushed', ref: `refs/heads/prep/${BRANCH}`, repo: 'octocat/react' }),
    ]);
    expect(run(['rev-parse', `refs/heads/prep/${BRANCH}`], fork)).toBe(sha);
    expect(fs.existsSync(marker)).toBe(false);
    // State lands in the pushing user's own reports dir, never the tick's paths.
    const saved = sm.setLastOvernight.mock.calls.at(-1)![0] as OvernightRecord;
    expect(saved.reportPath).toBe(path.join(tmp, 'reports', 'overnight-2026-09-22.md'));
    expect(saved.prepared[0]).toMatchObject({ pushedRef: `prep/${BRANCH}` });
    expect(saved.prepared[0].worktree).toBeUndefined();
    expect(fs.readFileSync(saved.reportPath, 'utf8')).toContain('# Overnight');
    expect(sm.setOvernightReportDocument).toHaveBeenCalled();
  });

  it('never follows a symlink in the drop dir', async () => {
    stage();
    const secret = path.join(tmp, 'secret');
    fs.writeFileSync(secret, 'token');
    fs.rmSync(path.join(drop, bundleFileFor(BRANCH)));
    fs.symlinkSync(secret, path.join(drop, bundleFileFor(BRANCH)));
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    fakeOctokit();

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0].status).toBe('failed');
    expect(out.results[0].reason).toMatch(/ELOOP|not a regular file|symbolic/i);
    expect(fs.existsSync(path.join(fork, 'refs', 'heads', 'prep'))).toBe(false);
  });

  it('skips a PR whose head is not on the login’s fork', async () => {
    stage();
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    fakeOctokit({ headOwner: 'mallory' });

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({ status: 'skipped' });
    expect(out.results[0].reason).toContain('mallory/react');
  });

  it('skips a fork of some other repo', async () => {
    stage();
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    fakeOctokit({ parent: 'mallory/react' });

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({ status: 'skipped' });
    expect(out.results[0].reason).toContain('not a fork of facebook/react');
  });

  it('targets <login>/<repo> for an issue URL (implement mode)', async () => {
    const sha = stage({ url: 'https://github.com/facebook/react/issues/7' });
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    const octokit = fakeOctokit();

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0]).toMatchObject({ status: 'pushed', repo: 'octocat/react' });
    expect(octokit.pulls.get).not.toHaveBeenCalled();
    expect(run(['rev-parse', `refs/heads/prep/${BRANCH}`], fork)).toBe(sha);
  });

  it('skips a recorded branch name that could leave prep/', async () => {
    stage();
    const file = path.join(drop, HANDOFF_STATE);
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    saved.prepared[0].branch = 'overnight/../../main';
    fs.writeFileSync(file, JSON.stringify(saved));
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    fakeOctokit();

    const out = await runOvernightPushPrep({ dryRun: false });

    expect(out.results[0].status).toBe('skipped');
    expect(fs.existsSync(path.join(fork, 'refs', 'heads', 'main'))).toBe(false);
  });

  it('refuses a state file that is not an overnight record', async () => {
    fs.writeFileSync(path.join(drop, HANDOFF_STATE), '{"runAt": 1}');
    vi.mocked(getStateManager).mockReturnValue(fakeStateManager() as never);
    fakeOctokit();

    await expect(runOvernightPushPrep({ dryRun: false })).rejects.toThrow(/not an overnight record/);
  });

  it('dry run plans without writing state or pushing', async () => {
    stage();
    const sm = fakeStateManager();
    vi.mocked(getStateManager).mockReturnValue(sm as never);
    fakeOctokit();

    const out = await runOvernightPushPrep({ dryRun: true });

    expect(out.results[0].status).toBe('planned');
    expect(sm.setLastOvernight).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(fork, 'refs', 'heads', 'prep'))).toBe(false);
  });
});

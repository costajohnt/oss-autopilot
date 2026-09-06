/**
 * Tests for the overnight prepare-and-queue command (#1574).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const tmp = vi.hoisted(() => ({ dir: '' }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: () => tmp.dir };
});

vi.mock('../core/paths.js', async () => {
  const actual = await vi.importActual<typeof import('../core/paths.js')>('../core/paths.js');
  return { ...actual, getReportsDir: () => tmp.dir };
});

vi.mock('../core/index.js', async () => {
  const actual = await vi.importActual<typeof import('../core/index.js')>('../core/index.js');
  return {
    ...actual,
    getStateManager: vi.fn(),
    requireGitHubToken: () => 'tok',
    maybeCheckpoint: vi.fn().mockResolvedValue(null),
  };
});

vi.mock('./daily.js', () => ({ executeDailyCheck: vi.fn() }));

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { executeDailyCheck } from './daily.js';
import {
  bucketize,
  renderReport,
  renderPreparedSection,
  replacePreparedSection,
  runOvernight,
  runOvernightRecord,
  overnightFreshness,
  renderLaunchdPlist,
  runOvernightSchedule,
  resolveClaudePath,
  LAUNCHD_LABEL,
  OVERNIGHT_ALLOWED_TOOLS,
  OVERNIGHT_DISALLOWED_TOOLS,
  reportDateFor,
} from './overnight.js';
import type { OvernightRecord } from '../core/types.js';
import { AgentStateSchema } from '../core/state-schema.js';

const mockGetStateManager = vi.mocked(getStateManager);
const mockDaily = vi.mocked(executeDailyCheck);
const mockCheckpoint = vi.mocked(maybeCheckpoint);

function fakeStateManager(initial?: OvernightRecord) {
  let last = initial;
  return {
    getLastOvernight: () => last,
    setLastOvernight: vi.fn((r: OvernightRecord) => {
      last = r;
    }),
  } as unknown as ReturnType<typeof getStateManager> & { setLastOvernight: ReturnType<typeof vi.fn> };
}

const pr = (type: string, n: number) => ({
  type,
  prUrl: `https://github.com/o/r/pull/${n}`,
  label: `[${type}]`,
  isNewContribution: false,
});

const attention = { needsAttention: 2, stuckCI: 1, dormantFollowup: 0, waiting: 3 };

beforeEach(() => {
  tmp.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-'));
  vi.clearAllMocks();
});

afterEach(() => {
  fs.rmSync(tmp.dir, { recursive: true, force: true });
});

describe('bucketize', () => {
  it('sends code work to prepare and replies to judgment', () => {
    const { prepare, judgment } = bucketize({
      actionableIssues: [
        pr('ci_failing', 1),
        pr('merge_conflict', 2),
        pr('needs_changes', 3),
        pr('incomplete_checklist', 4),
        pr('needs_response', 5),
      ] as never,
      commentedIssues: [
        {
          repo: 'o/r',
          number: 9,
          title: 't',
          url: 'https://github.com/o/r/issues/9',
          status: 'new_response',
          isFromMaintainer: true,
          lastResponseAuthor: 'm',
        },
        { repo: 'o/r', number: 10, title: 't', url: 'https://github.com/o/r/issues/10', status: 'waiting' },
      ] as never,
    });

    expect(prepare.map((i) => i.url)).toEqual([1, 2, 3, 4].map((n) => `https://github.com/o/r/pull/${n}`));
    expect(judgment.map((i) => [i.type, i.url])).toEqual([
      ['needs_response', 'https://github.com/o/r/pull/5'],
      ['issue_reply', 'https://github.com/o/r/issues/9'],
    ]);
    expect(judgment[1].reason).toContain('a maintainer');
  });
});

describe('renderReport', () => {
  it('renders every section and the no-side-effects line', () => {
    const md = renderReport({
      runAt: '2026-09-05T02:00:00.000Z',
      prepare: [{ url: 'u1', type: 'ci_failing', label: '[CI]', reason: 'red' }],
      judgment: [],
      attention,
      failures: [{ prUrl: 'https://github.com/o/r/pull/9', error: 'rate limited' }],
      warnings: [{ phase: 'repo-metadata', operation: 'fetch', message: 'boom' } as never],
    });

    expect(md).toContain(`# Overnight report — ${reportDateFor(new Date('2026-09-05T02:00:00.000Z'))}`);
    expect(md).toContain('Nothing was pushed, posted, or merged.');
    expect(md).toContain('## Prepared branches (0)');
    expect(md).toContain('## Queued for preparation (1)');
    expect(md).toContain('- [CI] u1 — red');
    expect(md).toContain('## Needs your judgment (0)');
    expect(md).toContain('- https://github.com/o/r/pull/9 could not be fetched (not bucketed): rate limited');
    expect(md).toContain('[repo-metadata] fetch: boom');
  });
});

describe('replacePreparedSection', () => {
  it('swaps the section without touching the sections around it', () => {
    const before = '# H\n\n## Prepared branches (0)\n\n_None recorded yet._\n\n## Queued for preparation (0)\n\nx\n';
    const section = renderPreparedSection([{ url: 'u', branch: 'b', recordedAt: 'now' }]);
    const after = replacePreparedSection(before, section);
    expect(after).toContain('## Prepared branches (1)');
    expect(after).toContain('- u — branch `b`');
    expect(after).not.toContain('_None recorded yet._');
    expect(after).toContain('## Queued for preparation (0)\n\nx\n');
    // The blank line between the rewritten section and the next heading survives.
    expect(after).toContain('- u — branch `b`\n\n## Queued for preparation (0)');
  });

  it('appends the section when the report lost it', () => {
    expect(replacePreparedSection('# H\n', 'S\n')).toBe('# H\n\nS\n');
    expect(replacePreparedSection('', 'S\n')).toBe('S\n');
  });
});

describe('runOvernight', () => {
  it('writes the report, records the run, and returns the buckets', async () => {
    const sm = fakeStateManager();
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [pr('ci_failing', 1), pr('needs_response', 2)],
      commentedIssues: [],
      attention,
      failures: [{ prUrl: 'u9', error: 'boom' }],
      warnings: [],
    } as never);

    const out = await runOvernight();

    expect(mockDaily).toHaveBeenCalledWith('tok');
    expect(out.prepare).toHaveLength(1);
    expect(out.judgment).toHaveLength(1);
    expect(out.failures).toEqual([{ prUrl: 'u9', error: 'boom' }]);
    expect(out.carriedPrepared).toBe(0);
    expect(out).not.toHaveProperty('gistSyncWarning');
    expect(mockCheckpoint).toHaveBeenCalledWith(sm, 'overnight');
    expect(sm.setLastOvernight.mock.invocationCallOrder[0]).toBeLessThan(mockCheckpoint.mock.invocationCallOrder[0]);
    expect(out.reportPath).toBe(path.join(tmp.dir, `overnight-${reportDateFor(new Date(out.runAt))}.md`));
    expect(fs.readFileSync(out.reportPath, 'utf8')).toContain('## Queued for preparation (1)');
    expect(sm.setLastOvernight).toHaveBeenCalledWith({
      runAt: out.runAt,
      reportPath: out.reportPath,
      prepareCount: 1,
      judgmentCount: 1,
      prepared: [],
    });
  });

  it('starts a fresh prepared list when the previous run was on another day', async () => {
    const prepared = [{ url: 'u1', branch: 'b1', recordedAt: 'x' }];
    const sm = fakeStateManager({
      runAt: 'earlier',
      reportPath: path.join(tmp.dir, 'overnight-2020-01-01.md'),
      prepareCount: 2,
      judgmentCount: 0,
      prepared,
    });
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      failures: [],
      warnings: [],
    } as never);

    const out = await runOvernight();

    expect(out.carriedPrepared).toBe(0);
    expect(sm.getLastOvernight()?.prepared).toEqual([]);
    expect(fs.readFileSync(out.reportPath, 'utf8')).toContain('## Prepared branches (0)');
  });

  it('carries recorded branches forward on a same-day re-run and surfaces a failed Gist push', async () => {
    const today = reportDateFor(new Date());
    const reportPath = path.join(tmp.dir, `overnight-${today}.md`);
    const prepared = [{ url: 'u1', branch: 'b1', recordedAt: 'x' }];
    const sm = fakeStateManager({ runAt: 'earlier', reportPath, prepareCount: 2, judgmentCount: 0, prepared });
    mockGetStateManager.mockReturnValue(sm);
    mockCheckpoint.mockResolvedValueOnce('push failed');
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      failures: [],
      warnings: [],
    } as never);

    const out = await runOvernight();

    expect(out.carriedPrepared).toBe(1);
    expect(out.gistSyncWarning).toBe('push failed');
    expect(sm.getLastOvernight()?.prepared).toEqual(prepared);
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('## Prepared branches (1)');
  });
});

describe('runOvernightRecord', () => {
  it('refuses before any run', async () => {
    mockGetStateManager.mockReturnValue(fakeStateManager());
    await expect(runOvernightRecord({ url: 'u', branch: 'b' })).rejects.toThrow(/run `overnight` first/);
  });

  it('flags a recreated report instead of silently rebuilding it', async () => {
    const reportPath = path.join(tmp.dir, 'gone.md');
    mockGetStateManager.mockReturnValue(
      fakeStateManager({ runAt: 'now', reportPath, prepareCount: 0, judgmentCount: 0, prepared: [] }),
    );
    const out = await runOvernightRecord({ url: 'u', branch: 'b' });
    expect(out.reportRecreated).toBe(true);
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('## Prepared branches (1)');
  });

  it('appends to state and rewrites the report section', async () => {
    const reportPath = path.join(tmp.dir, 'r.md');
    fs.writeFileSync(
      reportPath,
      '# H\n\n## Prepared branches (0)\n\n_None recorded yet._\n\n## Needs your judgment (0)\n',
    );
    const sm = fakeStateManager({ runAt: 'now', reportPath, prepareCount: 1, judgmentCount: 0, prepared: [] });
    mockGetStateManager.mockReturnValue(sm);

    mockCheckpoint.mockResolvedValueOnce('push failed');
    const first = await runOvernightRecord({ url: 'u1', branch: 'b1', worktree: '/w', note: 'fixed lint' });
    const second = await runOvernightRecord({ url: 'u2', branch: 'b2' });

    expect(first.preparedCount).toBe(1);
    expect(second.preparedCount).toBe(2);
    expect(first).not.toHaveProperty('reportRecreated');
    expect(first.gistSyncWarning).toBe('push failed');
    expect(second).not.toHaveProperty('gistSyncWarning');
    expect(mockCheckpoint).toHaveBeenCalledTimes(2);
    expect(sm.setLastOvernight.mock.invocationCallOrder[0]).toBeLessThan(mockCheckpoint.mock.invocationCallOrder[0]);
    const md = fs.readFileSync(reportPath, 'utf8');
    expect(md).toContain('## Prepared branches (2)');
    expect(md).toContain('- u1 — branch `b1` at /w: fixed lint');
    expect(md).toContain('- u2 — branch `b2`');
    expect(md).toContain('## Needs your judgment (0)');
    expect(sm.getLastOvernight()?.prepared.map((p) => p.branch)).toEqual(['b1', 'b2']);
  });
});

describe('overnightFreshness', () => {
  it('is undefined before the first run and ages in whole hours after', () => {
    mockGetStateManager.mockReturnValue(fakeStateManager());
    expect(overnightFreshness()).toBeUndefined();

    mockGetStateManager.mockReturnValue(
      fakeStateManager({
        runAt: '2026-09-05T02:00:00.000Z',
        reportPath: '/r.md',
        prepareCount: 3,
        judgmentCount: 2,
        prepared: [{ url: 'u', branch: 'b', recordedAt: 'x' }],
      }),
    );
    expect(overnightFreshness(new Date('2026-09-05T08:40:00.000Z'))).toEqual({
      runAt: '2026-09-05T02:00:00.000Z',
      reportPath: '/r.md',
      ageHours: 7,
      prepareCount: 3,
      judgmentCount: 2,
      preparedCount: 1,
    });
  });

  it('marks an unparseable runAt instead of emitting a non-finite ageHours', () => {
    mockGetStateManager.mockReturnValue(
      fakeStateManager({ runAt: 'garbage', reportPath: '/r.md', prepareCount: 0, judgmentCount: 0, prepared: [] }),
    );
    const fresh = overnightFreshness();
    expect(fresh?.runAtInvalid).toBe(true);
    expect(fresh).not.toHaveProperty('ageHours');
    expect(JSON.parse(JSON.stringify(fresh))).not.toHaveProperty('ageHours');
  });
});

describe('schedule', () => {
  it('files the report under the local calendar day', () => {
    expect(reportDateFor(new Date(2026, 0, 5, 2, 0, 0))).toBe('2026-01-05');
  });

  it('renders a plist that runs the plugin command at the given hour', () => {
    const plist = renderLaunchdPlist({ hour: 3, claudePath: '/opt/homebrew/bin/claude' }, '/log');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/claude</string>');
    expect(plist).toContain('<string>/oss-overnight</string>');
    expect(plist).toContain('<key>Hour</key><integer>3</integer>');
    expect(plist).toContain('<string>dontAsk</string>');
    expect(plist).toContain('<string>--disallowedTools</string>');
    expect(plist).toContain(`<string>${OVERNIGHT_DISALLOWED_TOOLS}</string>`);
    expect(plist).toContain('<string>Read,Edit,Write,Glob,Grep,Task,Bash(git clone *)');
    expect(plist).toContain('<string>/log</string>');
    // argv order, not just presence: a flag/value swap must fail here.
    const argv = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(argv.slice(1, 12)).toEqual([
      '/opt/homebrew/bin/claude',
      '-p',
      '/oss-overnight',
      '--permission-mode',
      'dontAsk',
      '--allowedTools',
      OVERNIGHT_ALLOWED_TOOLS,
      '--disallowedTools',
      OVERNIGHT_DISALLOWED_TOOLS,
      '--output-format',
      'text',
    ]);
  });

  it('XML-escapes paths so launchd can parse the plist', () => {
    const plist = renderLaunchdPlist({ hour: 2, claudePath: '/tmp/a&b/claude' }, '/log <x>');
    expect(plist).toContain('<string>/tmp/a&amp;b/claude</string>');
    expect(plist).toContain('<string>/log &lt;x&gt;</string>');
    expect(plist).not.toContain('a&b');
    expect(plist).toContain(`${path.dirname(process.execPath)}:/usr/local/bin`);
  });

  it('--install writes the plist under ~/Library/LaunchAgents with the rendered content', () => {
    const out = runOvernightSchedule({ hour: 2, claudePath: process.execPath, install: true });
    expect(out.installed).toBe(true);
    expect(out.plistPath).toBe(path.join(tmp.dir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`));
    expect(fs.readFileSync(out.plistPath, 'utf8')).toBe(out.plist);
    expect(fs.statSync(out.plistPath).mode & 0o777).toBe(0o644);
  });

  it('allowlist enforces the no-side-effects gate: no push, no gh writes, no shell escapes', () => {
    const rules = OVERNIGHT_ALLOWED_TOOLS.split(',');
    expect(rules).not.toContain('Bash(git *)');
    expect(rules).not.toContain('Bash(gh *)');
    expect(rules.some((r) => r.startsWith('Bash(git push'))).toBe(false);
    for (const write of [
      'gh pr create',
      'gh pr comment',
      'gh pr merge',
      'gh pr close',
      'gh issue comment',
      'gh run rerun',
      'gh api',
    ]) {
      expect(rules.some((r) => r.startsWith(`Bash(${write}`))).toBe(false);
    }
    for (const shell of ['bash', 'sh', 'zsh', 'npx', 'eval']) {
      expect(rules.some((r) => r.startsWith(`Bash(${shell} `))).toBe(false);
    }
    expect(rules).toContain('Bash(gh pr view *)');
    expect(rules).toContain('Bash(git rebase *)');
    expect(rules).not.toContain('Bash');
    expect(rules).not.toContain('Bash(*)');
    // Every Bash rule is a fixed-prefix rule for one of the five allowed programs.
    for (const r of rules.filter((x) => x.startsWith('Bash('))) {
      expect(r).toMatch(/^Bash\((git|gh|node|pnpm|npm)( [\w-]+)* \*\)$/);
    }
    const denied = OVERNIGHT_DISALLOWED_TOOLS.split(',');
    for (const must of [
      'Bash(git push *)',
      'Bash(gh pr merge *)',
      'Bash(gh pr comment *)',
      'Bash(gh api *)',
      'Bash(npm publish)',
      'Bash(npm publish *)',
      'Bash(npm unpublish *)',
      'Bash(npm deprecate *)',
      'Bash(pnpm publish)',
      'Bash(pnpm publish *)',
      'AskUserQuestion',
    ]) {
      expect(denied).toContain(must);
    }
  });

  it('resolves a bare binary name over PATH and refuses one that does not exist', () => {
    const bin = path.basename(process.execPath);
    expect(resolveClaudePath(bin, path.dirname(process.execPath))).toBe(process.execPath);
    expect(resolveClaudePath(process.execPath)).toBe(process.execPath);
    expect(() => resolveClaudePath('definitely-not-a-binary-xyz', '/nonexistent')).toThrow(/command -v claude/);
    expect(() => resolveClaudePath('/nonexistent/claude')).toThrow(/does not exist/);
  });

  it('rejects an out-of-range hour and does not write without --install', () => {
    expect(() => runOvernightSchedule({ hour: 24, claudePath: process.execPath, install: false })).toThrow(/0-23/);
    expect(() => runOvernightSchedule({ hour: Number('abc'), claudePath: process.execPath, install: false })).toThrow(
      /0-23/,
    );
    expect(() => runOvernightSchedule({ hour: 2.5, claudePath: process.execPath, install: false })).toThrow(/0-23/);
    const out = runOvernightSchedule({ hour: 2, claudePath: process.execPath, install: false });
    expect(out.plist).toContain(`<string>${process.execPath}</string>`);
    expect(out.installed).toBe(false);
    expect(out.plistPath).toMatch(/LaunchAgents\/com\.oss-autopilot\.overnight\.plist$/);
    expect(out.loadCommand).toContain('launchctl bootstrap');
  });
});

describe('lastOvernight schema', () => {
  it('round-trips, defaults prepared, rejects a negative count, and stays optional', () => {
    const parsed = AgentStateSchema.parse({
      version: 4,
      lastOvernight: { runAt: 'now', reportPath: '/r.md', prepareCount: 1, judgmentCount: 0 },
    });
    expect(parsed.lastOvernight).toEqual({
      runAt: 'now',
      reportPath: '/r.md',
      prepareCount: 1,
      judgmentCount: 0,
      prepared: [],
    });
    expect(() =>
      AgentStateSchema.parse({
        version: 4,
        lastOvernight: { runAt: 'now', reportPath: '/r.md', prepareCount: -1, judgmentCount: 0 },
      }),
    ).toThrow();
    expect(AgentStateSchema.parse({ version: 4 }).lastOvernight).toBeUndefined();
  });
});

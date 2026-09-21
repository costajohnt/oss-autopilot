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
// The curated list is a file the run reads; tests point it at a temp file or nowhere.
const listPath = { current: undefined as string | undefined };
vi.mock('./locate-issue-list.js', () => ({
  detectIssueListPath: () => (listPath.current ? { path: listPath.current, source: 'configured' } : undefined),
}));

import { getStateManager, maybeCheckpoint } from '../core/index.js';
import { executeDailyCheck } from './daily.js';
import {
  bucketize,
  renderReport,
  renderPreparedSection,
  replacePreparedSection,
  runOvernight,
  runOvernightRecord,
  runOvernightReport,
  runOvernightImplementBlocked,
  pickImplementCandidate,
  toolchainSkipReason,
  IMPLEMENT_TIER,
  publishReport,
  readReport,
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

/** Per-repo score stubs the fake state manager answers `getRepoScore` with; tests set entries. */
const repoLanguages: Record<string, { language: string | null } | undefined> = {};

function fakeStateManager(initial?: OvernightRecord, gistMode = false) {
  let last = initial;
  let doc: string | null = null;
  return {
    getLastOvernight: () => last,
    setLastOvernight: vi.fn((r: OvernightRecord) => {
      last = r;
    }),
    isGistMode: () => gistMode,
    getRepoScore: (repo: string) => repoLanguages[repo.toLowerCase()],
    getOvernightReportDocument: () => doc,
    setOvernightReportDocument: vi.fn((c: string) => {
      doc = c;
    }),
  } as unknown as ReturnType<typeof getStateManager> & {
    setLastOvernight: ReturnType<typeof vi.fn>;
    setOvernightReportDocument: ReturnType<typeof vi.fn>;
  };
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
  listPath.current = undefined;
  for (const k of Object.keys(repoLanguages)) delete repoLanguages[k];
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

    expect(prepare.map((i) => i.url)).toEqual([1, 2, 3].map((n) => `https://github.com/o/r/pull/${n}`));
    expect(judgment.map((i) => [i.type, i.url])).toEqual([
      ['incomplete_checklist', 'https://github.com/o/r/pull/4'],
      ['needs_response', 'https://github.com/o/r/pull/5'],
      ['issue_reply', 'https://github.com/o/r/issues/9'],
    ]);
    expect(judgment[2].reason).toContain('a maintainer');
  });
});

describe('renderReport', () => {
  it('renders every section and the no-side-effects line', () => {
    const md = renderReport({
      runAt: '2026-09-05T02:00:00.000Z',
      prepare: [{ url: 'u1', type: 'ci_failing', label: '[CI]', reason: 'red' }],
      judgment: [],
      attention,
      implement: null,
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
      digest: { openPRs: [] },
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
    expect(out).not.toHaveProperty('pendingLearnings');
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
      implementAttempts: [],
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
      digest: { openPRs: [] },
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
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
    } as never);

    const out = await runOvernight();

    expect(out.carriedPrepared).toBe(1);
    expect(out.gistSyncWarning).toBe('push failed');
    expect(sm.getLastOvernight()?.prepared).toEqual(prepared);
    expect(fs.readFileSync(reportPath, 'utf8')).toContain('## Prepared branches (1)');
  });

  it('forwards pendingLearnings from the daily check (#1696)', async () => {
    const pending = { repos: ['a/b'], prCount: 1 };
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
      pendingLearnings: pending,
    } as never);

    const out = await runOvernight();

    expect(out.pendingLearnings).toEqual(pending);
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
      reportAvailable: 'none',
    });
  });

  it('says where the report can be read from: the file here, else the Gist copy', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-fresh-'));
    const reportPath = path.join(dir, 'r.md');
    const record = { runAt: '2026-09-05T02:00:00.000Z', reportPath, prepareCount: 0, judgmentCount: 0, prepared: [] };
    const sm = fakeStateManager(record, true);
    mockGetStateManager.mockReturnValue(sm);
    expect(overnightFreshness()?.reportAvailable).toBe('none');
    sm.setOvernightReportDocument('# published elsewhere');
    expect(overnightFreshness()?.reportAvailable).toBe('gist');
    fs.writeFileSync(reportPath, '# local');
    expect(overnightFreshness()?.reportAvailable).toBe('local');
    fs.rmSync(dir, { recursive: true, force: true });
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
    const plist = renderLaunchdPlist({ hour: 3, claudePath: '/opt/homebrew/bin/claude' }, '/log', '/settings.json');
    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain('<string>/opt/homebrew/bin/claude</string>');
    expect(plist).toContain('<string>/oss-overnight</string>');
    expect(plist).toContain('<key>Hour</key><integer>3</integer>');
    expect(plist).toContain('<string>dontAsk</string>');
    // The CLI's own post/claim/push-prep refuse while this is set.
    expect(plist).toContain('<key>OSS_AUTOPILOT_UNATTENDED</key><string>1</string>');
    expect(plist).toContain('<string>--disallowedTools</string>');
    expect(plist).toContain(`<string>${OVERNIGHT_DISALLOWED_TOOLS}</string>`);
    expect(plist).toContain(
      '<string>Read,Edit,Write,Glob,Grep,Task,Bash(git clone),Bash(git clone *),Bash(git -C * clone)',
    );
    expect(plist).toContain('<string>/log</string>');
    // argv order, not just presence: a flag/value swap must fail here.
    const argv = [...plist.matchAll(/<string>([^<]*)<\/string>/g)].map((m) => m[1]);
    expect(argv.slice(1, 16)).toEqual([
      '/opt/homebrew/bin/claude',
      '-p',
      '/oss-overnight',
      '--permission-mode',
      'dontAsk',
      // The user's own settings would union their `Bash` allow into the list (#1697).
      '--setting-sources',
      '',
      '--settings',
      '/settings.json',
      '--allowedTools',
      OVERNIGHT_ALLOWED_TOOLS,
      '--disallowedTools',
      OVERNIGHT_DISALLOWED_TOOLS,
      '--output-format',
      'text',
    ]);
  });

  it('XML-escapes paths so launchd can parse the plist', () => {
    const plist = renderLaunchdPlist({ hour: 2, claudePath: '/tmp/a&b/claude' }, '/log <x>', '/s.json');
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
    // The settings layer the job runs with: only the plugin enablement, nothing from the user's own settings.
    expect(out.plist).toContain(`<string>${out.settingsPath}</string>`);
    expect(JSON.parse(fs.readFileSync(out.settingsPath, 'utf8'))).toEqual({
      enabledPlugins: { 'oss-autopilot@oss-autopilot': true },
    });
    expect(fs.statSync(out.settingsPath).mode & 0o777).toBe(0o600);
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
    // Every Bash rule names one of the five allowed programs and a fixed
    // subcommand; the only wildcard before the subcommand is git's `-C <dir>`.
    for (const r of rules.filter((x) => x.startsWith('Bash('))) {
      expect(r).toMatch(/^Bash\((git(?: -C \*)?|gh|node|pnpm|npm)( [\w-]+)*( \*)?\)$/);
    }
    // Directory-scoped work is allowed, directory-scoped push is not.
    expect(rules).toContain('Bash(git -C * fetch *)');
    expect(rules).toContain('Bash(git -C * worktree *)');
    expect(rules.some((r) => /push/.test(r))).toBe(false);
    const denied = OVERNIGHT_DISALLOWED_TOOLS.split(',');
    for (const must of [
      'Bash(git push *)',
      'Bash(git * push *)',
      'Bash(gh pr merge *)',
      'Bash(gh pr comment *)',
      'Bash(gh api *)',
      'Bash(npm publish)',
      'Bash(npm publish *)',
      'Bash(npm unpublish *)',
      'Bash(npm deprecate *)',
      'Bash(pnpm publish)',
      'Bash(pnpm publish *)',
      // Direct shell escapes inside the allowed programs (#1728): each can
      // spawn `git push` and void the push denies.
      'Bash(npm exec *)',
      'Bash(npm x *)',
      'Bash(pnpm dlx *)',
      'Bash(pnpm exec *)',
      'Bash(node -e *)',
      'Bash(node --eval *)',
      'Bash(node -p *)',
      'Bash(node --print *)',
      'Bash(node -pe *)',
      'Bash(node * -e *)',
      'Bash(npm * exec *)',
      'Bash(pnpm * exec *)',
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

describe('report publishing (#1698)', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-report-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('publishReport stages the file as the Gist document only in Gist mode', () => {
    const reportPath = path.join(dir, 'r.md');
    fs.writeFileSync(reportPath, '# report');
    const local = fakeStateManager(undefined, false);
    publishReport(local, reportPath);
    expect(local.setOvernightReportDocument).not.toHaveBeenCalled();

    const gist = fakeStateManager(undefined, true);
    publishReport(gist, reportPath);
    expect(gist.setOvernightReportDocument).toHaveBeenCalledWith('# report');
  });

  it('publishReport on a missing file is a warning, not a throw', () => {
    const gist = fakeStateManager(undefined, true);
    expect(() => publishReport(gist, path.join(dir, 'missing.md'))).not.toThrow();
    expect(gist.setOvernightReportDocument).not.toHaveBeenCalled();
  });

  it('runOvernight and runOvernightRecord publish after writing the report', async () => {
    const sm = fakeStateManager(undefined, true);
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
    } as never);
    await runOvernight();
    expect(sm.setOvernightReportDocument).toHaveBeenCalledTimes(1);
    expect(sm.setOvernightReportDocument.mock.calls[0][0]).toContain('## Prepared branches (0)');

    sm.setOvernightReportDocument.mockClear();
    const last = sm.getLastOvernight()!;
    await runOvernightRecord({ url: 'u', branch: 'b' });
    expect(sm.setOvernightReportDocument).toHaveBeenCalledTimes(1);
    expect(sm.setOvernightReportDocument.mock.calls[0][0]).toContain('branch `b`');
    expect(fs.existsSync(last.reportPath)).toBe(true);
  });

  it('readReport prefers the local file, falls back to the Gist copy, else none', () => {
    const reportPath = path.join(dir, 'r.md');
    const sm = fakeStateManager(undefined, true);
    expect(readReport(sm, reportPath)).toEqual({ source: 'none', content: null });
    sm.setOvernightReportDocument('# from gist');
    expect(readReport(sm, reportPath)).toEqual({ source: 'gist', content: '# from gist' });
    fs.writeFileSync(reportPath, '# local');
    expect(readReport(sm, reportPath)).toEqual({ source: 'local', content: '# local' });
  });

  it('runOvernightReport needs a run and returns the report with its source', () => {
    mockGetStateManager.mockReturnValue(fakeStateManager());
    expect(() => runOvernightReport()).toThrow(/No overnight run/);
    const sm = fakeStateManager(
      { runAt: 'now', reportPath: path.join(dir, 'gone.md'), prepareCount: 0, judgmentCount: 0, prepared: [] },
      true,
    );
    sm.setOvernightReportDocument('# from gist');
    mockGetStateManager.mockReturnValue(sm);
    expect(runOvernightReport()).toEqual({
      runAt: 'now',
      reportPath: path.join(dir, 'gone.md'),
      source: 'gist',
      content: '# from gist',
    });
  });
});

describe('implement tonight (#1715)', () => {
  const item = (repo: string, n: number, tier = IMPLEMENT_TIER) => ({
    repo,
    number: n,
    title: `t${n}`,
    tier,
    url: `https://github.com/${repo}/issues/${n}`,
  });
  const LIST = `# Vetted Issue List

## Pursue

- [#1](https://github.com/o/a/issues/1) — first
- [#2](https://github.com/o/b/issues/2) — second

## Maybe

- [#3](https://github.com/o/c/issues/3) — third
`;

  it('picks the first Pursue item with no open PR of yours on its repo and no earlier attempt', () => {
    const items = [item('o/a', 1), item('o/b', 2), item('o/c', 3, 'Maybe')];
    expect(pickImplementCandidate(items, [], [], '/l.md')?.url).toBe('https://github.com/o/a/issues/1');
    expect(pickImplementCandidate(items, [{ repo: 'O/A' }], [], '/l.md')?.url).toBe('https://github.com/o/b/issues/2');
    expect(
      pickImplementCandidate(
        items,
        [],
        [{ url: 'https://github.com/o/a/issues/1', attemptedAt: 'x', outcome: 'blocked' }],
        '/l.md',
      )?.url,
    ).toBe('https://github.com/o/b/issues/2');
    expect(pickImplementCandidate(items, [{ repo: 'o/a' }, { repo: 'o/b' }], [], '/l.md')).toBeNull();
    expect(pickImplementCandidate([item('o/c', 3, 'Maybe')], [], [], '/l.md')).toBeNull();
  });

  it('runOvernight queues one, remembers it, prunes attempts for issues that left the list, and reports it', async () => {
    listPath.current = path.join(tmp.dir, 'list.md');
    fs.writeFileSync(listPath.current, LIST);
    const sm = fakeStateManager({
      runAt: 'earlier',
      reportPath: '/old.md',
      prepareCount: 0,
      judgmentCount: 0,
      prepared: [],
      implementAttempts: [
        { url: 'https://github.com/o/a/issues/1', attemptedAt: 'x', outcome: 'blocked' },
        { url: 'https://github.com/o/gone/issues/9', attemptedAt: 'x', outcome: 'blocked' },
      ],
    });
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
    } as never);

    const out = await runOvernight();

    expect(out.implement?.url).toBe('https://github.com/o/b/issues/2');
    const saved = sm.setLastOvernight.mock.calls[0][0];
    expect(saved.implementUrl).toBe('https://github.com/o/b/issues/2');
    expect((saved.implementAttempts ?? []).map((a: { url: string }) => a.url)).toEqual([
      'https://github.com/o/a/issues/1',
    ]);
    expect(fs.readFileSync(out.reportPath, 'utf8')).toContain(
      '## Implement tonight (1)\n\n- o/b#2 https://github.com/o/b/issues/2',
    );
  });

  it('runOvernight with no readable list queues nothing and keeps attempts', async () => {
    const sm = fakeStateManager({
      runAt: 'earlier',
      reportPath: '/old.md',
      prepareCount: 0,
      judgmentCount: 0,
      prepared: [],
      implementAttempts: [{ url: 'u', attemptedAt: 'x', outcome: 'prepared' }],
    });
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [],
      commentedIssues: [],
      attention,
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
    } as never);
    const out = await runOvernight();
    expect(out.implement).toBeNull();
    expect(sm.setLastOvernight.mock.calls[0][0]).not.toHaveProperty('implementUrl');
    expect(sm.setLastOvernight.mock.calls[0][0].implementAttempts).toHaveLength(1);
    expect(fs.readFileSync(out.reportPath, 'utf8')).toContain('## Implement tonight (0)');
  });

  it('record marks the implement attempt prepared; implement-blocked marks it blocked; other URLs do neither', async () => {
    const reportPath = path.join(tmp.dir, 'r.md');
    fs.writeFileSync(reportPath, '# r\n');
    const base = {
      runAt: 'now',
      reportPath,
      prepareCount: 0,
      judgmentCount: 0,
      prepared: [],
      implementUrl: 'https://github.com/o/b/issues/2',
      implementAttempts: [],
    };
    let sm = fakeStateManager({ ...base });
    mockGetStateManager.mockReturnValue(sm);
    await runOvernightRecord({ url: 'https://github.com/o/x/pull/7', branch: 'b' });
    expect(sm.setLastOvernight.mock.calls[0][0].implementAttempts).toEqual([]);
    await runOvernightRecord({ url: 'https://github.com/o/b/issues/2', branch: 'overnight/issue-2' });
    expect(sm.setLastOvernight.mock.calls[1][0].implementAttempts).toMatchObject([
      { url: 'https://github.com/o/b/issues/2', outcome: 'prepared' },
    ]);

    sm = fakeStateManager({ ...base });
    mockGetStateManager.mockReturnValue(sm);
    await expect(runOvernightImplementBlocked({ url: 'https://github.com/o/other/issues/1' })).rejects.toThrow(
      /not tonight's implement item/,
    );
    const out = await runOvernightImplementBlocked({ url: 'https://github.com/o/b/issues/2', note: 'needs design' });
    expect(out.attemptCount).toBe(1);
    expect(sm.setLastOvernight.mock.calls[0][0].implementAttempts).toMatchObject([
      { outcome: 'blocked', note: 'needs design' },
    ]);
    expect(mockCheckpoint).toHaveBeenCalled();
  });
});

describe('toolchain gate (#1697)', () => {
  it('lets JS/TS and unknown languages through, names the rest', () => {
    expect(toolchainSkipReason('TypeScript')).toBeNull();
    expect(toolchainSkipReason('javascript')).toBeNull();
    expect(toolchainSkipReason(null)).toBeNull();
    expect(toolchainSkipReason(undefined)).toBeNull();
    expect(toolchainSkipReason('Rust')).toMatch(/^Rust repo: the headless run cannot execute its test suite/);
  });

  it('bucketize sends a CI failure on a Rust repo to judgment but still prepares its rebase', () => {
    const lang = (repo: string) => (repo === 'o/rusty' ? 'Rust' : 'TypeScript');
    const { prepare, judgment } = bucketize(
      {
        actionableIssues: [
          { type: 'ci_failing', prUrl: 'https://github.com/o/rusty/pull/1', label: '[CI]', isNewContribution: false },
          {
            type: 'merge_conflict',
            prUrl: 'https://github.com/o/rusty/pull/2',
            label: '[MC]',
            isNewContribution: false,
          },
          { type: 'ci_failing', prUrl: 'https://github.com/o/ts/pull/3', label: '[CI]', isNewContribution: false },
        ] as never,
        commentedIssues: [],
      },
      lang,
    );
    expect(prepare.map((i) => i.url)).toEqual(['https://github.com/o/rusty/pull/2', 'https://github.com/o/ts/pull/3']);
    expect(judgment).toHaveLength(1);
    expect(judgment[0].reason).toMatch(/Rust repo.*rerun or fix it from a machine that can/);
  });

  it('pickImplementCandidate skips Pursue items on repos it cannot verify', () => {
    const items = [
      { repo: 'o/rusty', number: 1, title: 't', tier: IMPLEMENT_TIER, url: 'https://github.com/o/rusty/issues/1' },
      { repo: 'o/ts', number: 2, title: 't', tier: IMPLEMENT_TIER, url: 'https://github.com/o/ts/issues/2' },
    ];
    const lang = (repo: string) => (repo === 'o/rusty' ? 'Rust' : null);
    expect(pickImplementCandidate(items, [], [], '/l.md', lang)?.url).toBe('https://github.com/o/ts/issues/2');
  });

  it('runOvernight reads the language from repo scores', async () => {
    repoLanguages['o/rusty'] = { language: 'Rust' };
    const sm = fakeStateManager();
    mockGetStateManager.mockReturnValue(sm);
    mockDaily.mockResolvedValue({
      actionableIssues: [
        { type: 'ci_failing', prUrl: 'https://github.com/o/rusty/pull/1', label: '[CI]', isNewContribution: false },
      ],
      commentedIssues: [],
      attention,
      digest: { openPRs: [] },
      failures: [],
      warnings: [],
    } as never);
    const out = await runOvernight();
    expect(out.prepare).toHaveLength(0);
    expect(out.judgment[0].reason).toMatch(/Rust repo/);
  });
});

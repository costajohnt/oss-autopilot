/**
 * Overnight autonomous mode (#1574): "prepare and queue", never "act externally".
 *
 * `overnight` runs the same check as `daily`, then splits what it found into
 * work an implementation agent can prepare in an isolated worktree without any
 * external side effect (`prepare`) and items that need a human reply or
 * decision (`judgment`). It writes a dated morning report under
 * `~/.oss-autopilot/reports/` and records the run in state so `startup` can
 * surface its freshness.
 *
 * `overnight record` appends one prepared branch to the report and to state;
 * the plugin calls it after each agent finishes. `overnight schedule` renders
 * the launchd plist that runs the plugin command headlessly.
 *
 * Hard gate: nothing in this module pushes, posts, or merges. That gate is the
 * feature, not a limitation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getStateManager, maybeCheckpoint, requireGitHubToken } from '../core/index.js';
import { warn } from '../core/logger.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
import { getReportsDir } from '../core/paths.js';
import type { ActionableIssueType, OvernightPrepared } from '../core/types.js';
import type { DailyOutput, DailyWarning } from '../formatters/json.js';
import type { AttentionSummary } from '../core/pr-attention.js';
import { executeDailyCheck } from './daily.js';

type OvernightBucket = 'prepare' | 'judgment';

/** One item in either bucket; which bucket is the array it lives in. */
export interface OvernightItem {
  /** PR or issue URL. */
  url: string;
  type: ActionableIssueType | 'issue_reply';
  label: string;
  /** One line of why it landed in its bucket, for the report. */
  reason: string;
}

export interface OvernightOutput {
  runAt: string;
  reportPath: string;
  prepare: OvernightItem[];
  judgment: OvernightItem[];
  attention: AttentionSummary;
  /** PRs the daily check could not fetch; each is absent from the buckets above. */
  failures: PRCheckFailure[];
  warnings: DailyWarning[];
  /** Branches carried over from an earlier run on the same date (a re-run never drops recorded work). */
  carriedPrepared: number;
  /** Set when the run could not be pushed to the Gist; the local cache has it. */
  gistSyncWarning?: string;
}

const MODULE = 'overnight';

type ReportBody = Pick<OvernightOutput, 'runAt' | 'prepare' | 'judgment' | 'attention' | 'failures' | 'warnings'>;

/** Freshness block `startup` surfaces (#1574). */
export interface OvernightFreshness {
  runAt: string;
  reportPath: string;
  /** Whole hours since the run; absent when `runAt` does not parse (see `runAtInvalid`). */
  ageHours?: number;
  runAtInvalid?: true;
  prepareCount: number;
  judgmentCount: number;
  /** Branches recorded via `overnight record` since the run. */
  preparedCount: number;
}

// ponytail: static table, not a classifier. Every ActionableIssueType is
// listed: the Record key type makes a new variant fail typecheck here.
const BUCKET_BY_TYPE: Record<ActionableIssueType, { bucket: OvernightBucket; reason: string }> = {
  ci_failing: { bucket: 'prepare', reason: 'CI is red: an agent can diagnose and prepare a fix branch' },
  merge_conflict: { bucket: 'prepare', reason: 'merge conflict: an agent can rebase in a worktree' },
  needs_changes: { bucket: 'prepare', reason: 'changes requested: an agent can prepare the requested edits' },
  incomplete_checklist: { bucket: 'prepare', reason: 'checklist incomplete: an agent can fill in the missing items' },
  needs_response: { bucket: 'judgment', reason: 'a maintainer is waiting on your reply' },
};

/** Pure: split the daily check into prepare vs judgment items. */
export function bucketize(daily: Pick<DailyOutput, 'actionableIssues' | 'commentedIssues'>): {
  prepare: OvernightItem[];
  judgment: OvernightItem[];
} {
  const prepare: OvernightItem[] = [];
  const judgment: OvernightItem[] = [];

  for (const issue of daily.actionableIssues) {
    const rule = BUCKET_BY_TYPE[issue.type];
    (rule.bucket === 'prepare' ? prepare : judgment).push({
      url: issue.prUrl,
      type: issue.type,
      label: issue.label,
      reason: rule.reason,
    });
  }

  for (const c of daily.commentedIssues) {
    if (c.status !== 'new_response') continue;
    judgment.push({
      url: c.url,
      type: 'issue_reply',
      label: `[Issue reply] ${c.repo}#${c.number}`,
      reason: `${c.isFromMaintainer ? 'a maintainer' : c.lastResponseAuthor} replied on an issue you commented on`,
    });
  }

  return { prepare, judgment };
}

const PREPARED_HEADING = '## Prepared branches (';

/** Pure: the "Prepared branches" section; `record` rewrites just this part. */
export function renderPreparedSection(prepared: OvernightPrepared[]): string {
  const lines = [`${PREPARED_HEADING}${prepared.length})`, ''];
  if (prepared.length === 0) lines.push('_None recorded yet._');
  for (const p of prepared) {
    lines.push(
      `- ${p.url} — branch \`${p.branch}\`${p.worktree ? ` at ${p.worktree}` : ''}${p.note ? `: ${p.note}` : ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** Pure: the morning report. Prepared branches are appended by `record`. */
export function renderReport(out: ReportBody, prepared: OvernightPrepared[] = []): string {
  const lines: string[] = [];
  lines.push(`# Overnight report — ${reportDateFor(new Date(out.runAt))}`, '');
  lines.push(`Run at ${out.runAt}. Nothing was pushed, posted, or merged.`, '');
  lines.push(
    `Attention: ${out.attention.needsAttention} need attention, ${out.attention.stuckCI} stuck CI, ${out.attention.dormantFollowup} dormant, ${out.attention.waiting} waiting.`,
    '',
  );

  lines.push(renderPreparedSection(prepared));

  lines.push(`## Queued for preparation (${out.prepare.length})`, '');
  if (out.prepare.length === 0) lines.push('_Nothing to prepare._');
  for (const i of out.prepare) lines.push(`- ${i.label} ${i.url} — ${i.reason}`);
  lines.push('');

  lines.push(`## Needs your judgment (${out.judgment.length})`, '');
  if (out.judgment.length === 0) lines.push('_Nothing waiting on you._');
  for (const i of out.judgment) lines.push(`- ${i.label} ${i.url} — ${i.reason}`);
  lines.push('');

  if (out.failures.length > 0 || out.warnings.length > 0) {
    lines.push('## Check problems', '');
    for (const f of out.failures) lines.push(`- ${f.prUrl} could not be fetched (not bucketed): ${f.error}`);
    for (const w of out.warnings) lines.push(`- [${w.phase}] ${w.operation}: ${w.message}`);
    lines.push('');
  }

  return lines.join('\n');
}

/** Local calendar date: the job fires at a local hour, so the report is filed under the local day. */
export function reportDateFor(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function reportPathFor(d: Date): string {
  return path.join(getReportsDir(), `overnight-${reportDateFor(d)}.md`);
}

export async function runOvernight(): Promise<OvernightOutput> {
  const sm = getStateManager();
  const daily = await executeDailyCheck(requireGitHubToken());
  const now = new Date();
  const runAt = now.toISOString();
  const { prepare, judgment } = bucketize(daily);
  const body: ReportBody = {
    runAt,
    prepare,
    judgment,
    attention: daily.attention,
    failures: daily.failures,
    warnings: daily.warnings,
  };
  const reportPath = reportPathFor(now);
  // A re-run on the same date (launchd retry, manual) must not drop branches
  // already recorded: they are still on disk, so keep them in state and report.
  const previous = sm.getLastOvernight();
  const carried = previous?.reportPath === reportPath ? previous.prepared : [];
  fs.writeFileSync(reportPath, renderReport(body, carried), { mode: 0o600 });

  sm.setLastOvernight({
    runAt,
    reportPath,
    prepareCount: prepare.length,
    judgmentCount: judgment.length,
    prepared: carried,
  });
  // executeDailyCheck already checkpointed the Gist; this write came after it,
  // and in Gist mode setLastOvernight only reaches the local cache (#1629 class).
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE);

  return { ...body, reportPath, carriedPrepared: carried.length, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
}

export interface OvernightRecordOptions {
  url: string;
  branch: string;
  worktree?: string;
  note?: string;
}

export interface OvernightRecordOutput {
  reportPath: string;
  preparedCount: number;
  /** The report file was missing and has been recreated with only the prepared section. */
  reportRecreated?: true;
  gistSyncWarning?: string;
}

/** Append one prepared branch to state and to the report of the latest run. */
export async function runOvernightRecord(options: OvernightRecordOptions): Promise<OvernightRecordOutput> {
  const sm = getStateManager();
  const last = sm.getLastOvernight();
  if (!last) throw new Error('No overnight run recorded yet; run `overnight` first.');

  const entry: OvernightPrepared = {
    url: options.url,
    branch: options.branch,
    worktree: options.worktree,
    note: options.note,
    recordedAt: new Date().toISOString(),
  };
  const prepared = [...last.prepared, entry];
  sm.setLastOvernight({ ...last, prepared });

  // Rewrite the section in place (state is the source of truth for the
  // list) so its heading count stays right; a report someone deleted is
  // recreated with just this section rather than failing the record.
  const reportExists = fs.existsSync(last.reportPath);
  if (!reportExists) warn(MODULE, `Report ${last.reportPath} is missing; recreating it with only the prepared section`);
  const reportBody = reportExists ? fs.readFileSync(last.reportPath, 'utf8') : '';
  fs.writeFileSync(last.reportPath, replacePreparedSection(reportBody, renderPreparedSection(prepared)), {
    mode: 0o600,
  });
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE);

  return {
    reportPath: last.reportPath,
    preparedCount: prepared.length,
    ...(reportExists ? {} : { reportRecreated: true as const }),
    ...(gistSyncWarning ? { gistSyncWarning } : {}),
  };
}

/** Pure: swap the "Prepared branches" section (up to the next `## `) for `section`. */
export function replacePreparedSection(report: string, section: string): string {
  const start = report.indexOf(PREPARED_HEADING);
  if (start === -1) return report.length === 0 ? section : `${report.trimEnd()}\n\n${section}`;
  const next = report.indexOf('\n## ', start + PREPARED_HEADING.length);
  return report.slice(0, start) + section + (next === -1 ? '' : report.slice(next));
}

/** Freshness for `startup` (#1574); undefined before the first overnight run. */
export function overnightFreshness(now: Date = new Date()): OvernightFreshness | undefined {
  const last = getStateManager().getLastOvernight();
  if (!last) return undefined;
  const ageMs = now.getTime() - Date.parse(last.runAt);
  const base = {
    runAt: last.runAt,
    reportPath: last.reportPath,
    prepareCount: last.prepareCount,
    judgmentCount: last.judgmentCount,
    preparedCount: last.prepared.length,
  };
  // Never emit a non-finite number into the JSON contract (Infinity serialises as null).
  return Number.isNaN(ageMs)
    ? { ...base, runAtInvalid: true }
    : { ...base, ageHours: Math.max(0, Math.round(ageMs / 36e5)) };
}

export interface ScheduleOptions {
  /** Local hour (0-23) the job fires. */
  hour: number;
  /** Path to the `claude` binary; launchd does not inherit a shell PATH. */
  claudePath: string;
  install: boolean;
}

export const LAUNCHD_LABEL = 'com.oss-autopilot.overnight';

/**
 * Tools the headless run may use without a prompt (see commands/oss-overnight.md).
 *
 * The allowlist is the enforcement half of the no-side-effects gate, so it is
 * enumerated, not wildcarded: every git subcommand except `push`, only the
 * read side of `gh` (no `create`/`comment`/`merge`/`close`/`rerun`, no `gh api`
 * because it can POST), and no `bash`/`sh`/`npx` shell escapes. `node`, `pnpm`
 * and `npm` stay because the CLI bundle and a repo's test suite are already
 * arbitrary code; the credential-bearing writes are what the list keeps out.
 * Stronger isolation (a dedicated user with no push credentials, or a
 * container) is the upgrade path if that trust level is not acceptable.
 */
const GIT_SUBCOMMANDS = [
  'clone',
  'fetch',
  'worktree',
  'checkout',
  'switch',
  'branch',
  'rebase',
  'merge-base',
  'status',
  'diff',
  'log',
  'show',
  'add',
  'commit',
  'rev-parse',
  'remote',
];
const GH_READ_SUBCOMMANDS = [
  'pr view',
  'pr checks',
  'pr diff',
  'pr list',
  'run view',
  'run list',
  'issue view',
  'repo view',
  'auth status',
];
/**
 * Deny list layered under the allowlist (deny beats allow): even if a future
 * allow rule widens, these never run unattended. `AskUserQuestion` is denied
 * because nobody can answer; the preparer agent reports `blocked` instead.
 */
export const OVERNIGHT_DISALLOWED_TOOLS = [
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(gh pr create *)',
  'Bash(gh pr comment *)',
  'Bash(gh pr merge *)',
  'Bash(gh pr close *)',
  'Bash(gh pr edit *)',
  'Bash(gh pr ready *)',
  'Bash(gh issue create *)',
  'Bash(gh issue comment *)',
  'Bash(gh issue close *)',
  'Bash(gh run rerun *)',
  'Bash(gh api *)',
  'AskUserQuestion',
].join(',');

export const OVERNIGHT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Task',
  ...GIT_SUBCOMMANDS.map((sub) => `Bash(git ${sub} *)`),
  ...GH_READ_SUBCOMMANDS.map((sub) => `Bash(gh ${sub} *)`),
  'Bash(node *)',
  'Bash(pnpm *)',
  'Bash(npm *)',
].join(',');

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure: the launchd plist that runs `/oss-overnight` headlessly. */
export function renderLaunchdPlist(options: Pick<ScheduleOptions, 'hour' | 'claudePath'>, logPath: string): string {
  // Headless `-p` starts in manual permission mode, where any unapproved tool
  // call fails (nobody can answer). `dontAsk` + the enumerated allowlist above
  // is the documented unattended shape and the enforcement half of the gate.
  const args = [
    options.claudePath,
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
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map((a) => `    <string>${xmlEscape(a)}</string>`),
    '  </array>',
    '  <key>StartCalendarInterval</key>',
    `  <dict><key>Hour</key><integer>${options.hour}</integer><key>Minute</key><integer>0</integer></dict>`,
    `  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>`,
    `  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>`,
    '  <key>EnvironmentVariables</key>',
    // launchd inherits no shell PATH; include the dir of the node that ran
    // `schedule` so a version-manager node resolves for the CLI and tests.
    `  <dict><key>PATH</key><string>${xmlEscape(`${path.dirname(process.execPath)}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`)}</string></dict>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface ScheduleOutput {
  plist: string;
  plistPath: string;
  installed: boolean;
  /** The one command the user runs to (re)load the job. */
  loadCommand: string;
}

/**
 * launchd runs the plist with its own PATH, so a bare `claude` that resolves in
 * the user's shell would fail silently at 02:00 into the log. Resolve it now,
 * against this process's PATH, and embed the absolute path.
 */
export function resolveClaudePath(claudePath: string, envPath: string | undefined = process.env.PATH): string {
  const hint = 'pass --claude-path "$(command -v claude)"';
  if (path.isAbsolute(claudePath)) {
    if (!fs.existsSync(claudePath)) throw new Error(`--claude-path ${claudePath} does not exist; ${hint}`);
    return claudePath;
  }
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, claudePath);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not find "${claudePath}" on PATH; ${hint}`);
}

export function runOvernightSchedule(options: ScheduleOptions): ScheduleOutput {
  if (!Number.isInteger(options.hour) || options.hour < 0 || options.hour > 23) {
    throw new Error(`--hour must be an integer 0-23, got ${options.hour}`);
  }
  const claudePath = resolveClaudePath(options.claudePath);
  const plistPath = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  const logPath = path.join(getReportsDir(), 'overnight-launchd.log');
  const plist = renderLaunchdPlist({ hour: options.hour, claudePath }, logPath);
  if (options.install) {
    fs.mkdirSync(path.dirname(plistPath), { recursive: true });
    fs.writeFileSync(plistPath, plist, { mode: 0o644 });
  }
  return {
    plist,
    plistPath,
    installed: options.install,
    loadCommand: `launchctl bootout gui/$(id -u) ${plistPath} 2>/dev/null; launchctl bootstrap gui/$(id -u) ${plistPath}`,
  };
}

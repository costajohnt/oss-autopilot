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
 * feature, not a limitation. The one deliberate exception, `overnight
 * push-prep` (#1698), lives in `overnight-push-prep.ts` and is never run by
 * the model: a scheduler runs it after the tick, and it only pushes to
 * `prep/*` on the user's own fork.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { errorMessage, getStateManager, maybeCheckpoint, requireGitHubToken } from '../core/index.js';
import { warn } from '../core/logger.js';
import type { PRCheckFailure } from '../core/pr-monitor.js';
import { getReportsDir } from '../core/paths.js';
import type { ActionableIssueType, OvernightImplementAttempt, OvernightPrepared } from '../core/types.js';
import { detectIssueListPath } from './locate-issue-list.js';
import { parseIssueList } from './parse-list.js';
import type { DailyOutput, DailyWarning, PendingLearnings } from '../formatters/json.js';
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
  /**
   * The one curated-list issue to implement tonight (#1715): first item of
   * the list's Pursue tier whose repo has no open PR of yours and that no
   * earlier run has attempted. Null when the list is absent or exhausted.
   */
  implement: OvernightImplementItem | null;
  /** Set when the run could not be pushed to the Gist; the local cache has it. */
  gistSyncWarning?: string;
  /** Repos whose merged-PR learnings the overnight run should extract (#1696); absent when none. */
  pendingLearnings?: PendingLearnings;
}

const MODULE = 'overnight';

type ReportBody = Pick<
  OvernightOutput,
  'runAt' | 'prepare' | 'judgment' | 'attention' | 'failures' | 'warnings' | 'implement'
>;

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
  /** `local`: the file at `reportPath` is here. `gist`: only the published copy, read it with `overnight report`. */
  reportAvailable: ReportAvailability;
}

// ponytail: static table, not a classifier. Every ActionableIssueType is
// listed: the Record key type makes a new variant fail typecheck here.
const BUCKET_BY_TYPE: Record<ActionableIssueType, { bucket: OvernightBucket; reason: string }> = {
  ci_failing: { bucket: 'prepare', reason: 'CI is red: an agent can diagnose and prepare a fix branch' },
  merge_conflict: { bucket: 'prepare', reason: 'merge conflict: an agent can rebase in a worktree' },
  needs_changes: { bucket: 'prepare', reason: 'changes requested: an agent can prepare the requested edits' },
  // The gaps are PR-body checkboxes, and the only way to tick them is
  // `gh pr edit --body`, a write the unattended run must not make. Two
  // nights of preparers spent on these both ended blocked with a suggested
  // body edit for the morning, so that suggestion is now the judgment item.
  incomplete_checklist: {
    bucket: 'judgment',
    reason: 'checklist incomplete: the gaps are PR-body checkboxes, which only you can edit',
  },
  needs_response: { bucket: 'judgment', reason: 'a maintainer is waiting on your reply' },
};

/** A curated-list issue picked for implementation (#1715). */
export interface OvernightImplementItem {
  url: string;
  repo: string;
  number: number;
  title: string;
  /** Why this one: the tier it came from and the list path. */
  reason: string;
}

/** The tier name the curated list uses for issues John already vetted and wants done. */
export const IMPLEMENT_TIER = 'Pursue';

/**
 * Pure: the one list issue to implement tonight, or null. First Pursue item
 * (list order is the user's priority order) whose repo has no open PR of the
 * user's (one PR per repo at a time keeps maintainers' review load sane and
 * respects repos with a one-open-PR rule) and that no earlier run attempted.
 */
export function pickImplementCandidate(
  items: { url: string; repo: string; number: number; title: string; tier: string }[],
  openPRs: { repo: string }[],
  attempts: OvernightImplementAttempt[],
  listPath: string,
): OvernightImplementItem | null {
  const busyRepos = new Set(openPRs.map((p) => p.repo.toLowerCase()));
  const tried = new Set(attempts.map((a) => a.url));
  for (const it of items) {
    if (it.tier !== IMPLEMENT_TIER) continue;
    if (tried.has(it.url)) continue;
    if (busyRepos.has(it.repo.toLowerCase())) continue;
    return {
      url: it.url,
      repo: it.repo,
      number: it.number,
      title: it.title,
      reason: `${IMPLEMENT_TIER} tier of ${listPath}, no open PR of yours on ${it.repo}`,
    };
  }
  return null;
}

/** The curated list's available items, or null when there is no readable list. */
function loadListItems(): { items: ReturnType<typeof parseIssueList>['available']; path: string } | null {
  const located = detectIssueListPath();
  if (!located) return null;
  try {
    return { items: parseIssueList(fs.readFileSync(located.path, 'utf8')).available, path: located.path };
  } catch (err) {
    warn(MODULE, `Could not read the issue list at ${located.path}: ${errorMessage(err)}`);
    return null;
  }
}

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
    const pushed = p.pushedRef
      ? ` (pushed to \`${p.pushedRef}\`${p.compareUrl ? `, compare ${p.compareUrl}` : ''})`
      : p.pushProblem
        ? ` (NOT pushed: ${p.pushProblem})`
        : '';
    lines.push(
      `- ${p.url} — branch \`${p.branch}\`${p.worktree ? ` at ${p.worktree}` : ''}${pushed}${p.note ? `: ${p.note}` : ''}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Rewrite the "Prepared branches" section of `reportPath` from `prepared`
 * (state is the source of truth for the list, so the heading count stays
 * right). A report someone deleted is recreated with just this section
 * rather than failing the caller; `reportRecreated` says so.
 */
export function writePreparedSection(reportPath: string, prepared: OvernightPrepared[]): { reportRecreated: boolean } {
  const reportExists = fs.existsSync(reportPath);
  if (!reportExists) warn(MODULE, `Report ${reportPath} is missing; recreating it with only the prepared section`);
  const reportBody = reportExists ? fs.readFileSync(reportPath, 'utf8') : '';
  fs.writeFileSync(reportPath, replacePreparedSection(reportBody, renderPreparedSection(prepared)), { mode: 0o600 });
  return { reportRecreated: !reportExists };
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

  lines.push(`## Implement tonight (${out.implement ? 1 : 0})`, '');
  if (out.implement)
    lines.push(`- ${out.implement.repo}#${out.implement.number} ${out.implement.url} — ${out.implement.reason}`);
  else
    lines.push('_No list issue queued: the Pursue tier is empty, exhausted, or every repo has an open PR of yours._');
  lines.push('');

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
  const previous = sm.getLastOvernight();
  const list = loadListItems();
  // Attempts survive across runs; the ones whose issue left the list are
  // dropped so a re-added issue can be tried again.
  const attempts = (previous?.implementAttempts ?? []).filter((a) => !list || list.items.some((i) => i.url === a.url));
  const implement = list ? pickImplementCandidate(list.items, daily.digest.openPRs, attempts, list.path) : null;
  const body: ReportBody = {
    runAt,
    prepare,
    judgment,
    implement,
    attention: daily.attention,
    failures: daily.failures,
    warnings: daily.warnings,
  };
  const reportPath = reportPathFor(now);
  // A re-run on the same date (launchd retry, manual) must not drop branches
  // already recorded: they are still on disk, so keep them in state and report.
  const carried = previous?.reportPath === reportPath ? previous.prepared : [];
  fs.writeFileSync(reportPath, renderReport(body, carried), { mode: 0o600 });
  publishReport(sm, reportPath);

  sm.setLastOvernight({
    runAt,
    reportPath,
    prepareCount: prepare.length,
    judgmentCount: judgment.length,
    prepared: carried,
    ...(implement ? { implementUrl: implement.url } : {}),
    implementAttempts: attempts,
  });
  // executeDailyCheck already checkpointed the Gist; this write came after it,
  // and in Gist mode setLastOvernight only reaches the local cache (#1629 class).
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE);

  return {
    ...body,
    reportPath,
    carriedPrepared: carried.length,
    ...(gistSyncWarning ? { gistSyncWarning } : {}),
    ...(daily.pendingLearnings ? { pendingLearnings: daily.pendingLearnings } : {}),
  };
}

export interface OvernightImplementBlockedOptions {
  url: string;
  note?: string;
}

export interface OvernightImplementBlockedOutput {
  url: string;
  attemptCount: number;
  gistSyncWarning?: string;
}

/**
 * `overnight implement-blocked` (#1715): the preparer could not produce a
 * branch for tonight's list issue. Remember that so the next run picks the
 * next Pursue item instead of retrying this one every night; the note lands
 * in the report's Blocked section like any other blocked item.
 */
export async function runOvernightImplementBlocked(
  options: OvernightImplementBlockedOptions,
): Promise<OvernightImplementBlockedOutput> {
  const sm = getStateManager();
  const last = sm.getLastOvernight();
  if (!last) throw new Error('No overnight run recorded yet; run `overnight` first.');
  if (options.url !== last.implementUrl) {
    throw new Error(`${options.url} is not tonight's implement item (${last.implementUrl ?? 'none queued'})`);
  }
  const implementAttempts = [
    ...(last.implementAttempts ?? []),
    { url: options.url, attemptedAt: new Date().toISOString(), outcome: 'blocked' as const, note: options.note },
  ];
  sm.setLastOvernight({ ...last, implementAttempts });
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE);
  return { url: options.url, attemptCount: implementAttempts.length, ...(gistSyncWarning ? { gistSyncWarning } : {}) };
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
  // Recording the branch for tonight's list issue is what marks the attempt
  // as prepared, so the next run moves on to the next Pursue item.
  const implementAttempts =
    options.url === last.implementUrl
      ? [
          ...(last.implementAttempts ?? []),
          { url: options.url, attemptedAt: entry.recordedAt, outcome: 'prepared' as const },
        ]
      : last.implementAttempts;
  sm.setLastOvernight({ ...last, prepared, implementAttempts });

  const { reportRecreated } = writePreparedSection(last.reportPath, prepared);
  publishReport(sm, last.reportPath);
  const gistSyncWarning = await maybeCheckpoint(sm, MODULE);

  return {
    reportPath: last.reportPath,
    preparedCount: prepared.length,
    ...(reportRecreated ? { reportRecreated: true as const } : {}),
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

/**
 * Stage the report file's current contents as the Gist's `overnight-report.md`
 * (#1698), so `/oss` on another machine can read what a headless box wrote.
 * Callers checkpoint right after. A report that cannot be read is a warning,
 * not a failure: the run itself succeeded.
 */
export function publishReport(sm: ReturnType<typeof getStateManager>, reportPath: string): void {
  if (!sm.isGistMode()) return;
  try {
    sm.setOvernightReportDocument(fs.readFileSync(reportPath, 'utf8'));
  } catch (err) {
    warn(MODULE, `Could not publish ${reportPath} to the Gist: ${errorMessage(err)}`);
  }
}

/** Where `overnight report` can read the morning report from. */
export type ReportAvailability = 'local' | 'gist' | 'none';

/**
 * The morning report's text and where it came from: the local file when it
 * exists (the machine that ran overnight), else the Gist copy (any other
 * machine in Gist mode), else nothing.
 */
export function readReport(
  sm: ReturnType<typeof getStateManager>,
  reportPath: string,
): { source: ReportAvailability; content: string | null } {
  if (fs.existsSync(reportPath)) return { source: 'local', content: fs.readFileSync(reportPath, 'utf8') };
  const gist = sm.getOvernightReportDocument();
  return gist ? { source: 'gist', content: gist } : { source: 'none', content: null };
}

export interface OvernightReportOutput {
  runAt: string;
  reportPath: string;
  source: ReportAvailability;
  content: string | null;
}

/** `overnight report`: print the latest morning report from wherever it is readable. */
export function runOvernightReport(): OvernightReportOutput {
  const sm = getStateManager();
  const last = sm.getLastOvernight();
  if (!last) throw new Error('No overnight run recorded yet; run `overnight` first.');
  return { runAt: last.runAt, reportPath: last.reportPath, ...readReport(sm, last.reportPath) };
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
    reportAvailable: readReport(getStateManager(), last.reportPath).source,
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
  // The -C form of push: `git -C <dir> push` would otherwise slip past a
  // prefix rule on `git push`.
  'Bash(git * push)',
  'Bash(git * push *)',
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
  // `npm`/`pnpm` are allowed for builds and tests, but a token in ~/.npmrc
  // would let their registry writes ship a release unattended — exactly the
  // credential-bearing writes the gate exists to keep out.
  'Bash(npm publish)',
  'Bash(npm publish *)',
  'Bash(npm unpublish *)',
  'Bash(npm deprecate *)',
  'Bash(pnpm publish)',
  'Bash(pnpm publish *)',
  'AskUserQuestion',
].join(',');

export const OVERNIGHT_ALLOWED_TOOLS = [
  'Read',
  'Edit',
  'Write',
  'Glob',
  'Grep',
  'Task',
  // Both the bare and the `-C <dir>` forms: a preparer's worktree is never its
  // cwd, and `cd <dir> && git ...` is denied under dontAsk, so without `-C`
  // every preparer blocks (#1697).
  ...GIT_SUBCOMMANDS.flatMap((sub) => [
    `Bash(git ${sub})`,
    `Bash(git ${sub} *)`,
    `Bash(git -C * ${sub})`,
    `Bash(git -C * ${sub} *)`,
  ]),
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

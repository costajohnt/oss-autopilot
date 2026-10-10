/**
 * `overnight push-prep` (#1698): the deterministic step that stages prepared
 * branches on the user's fork under `prep/*`, so the machine where `/oss`
 * runs can see what a headless overnight box prepared.
 *
 * The model never runs this. A scheduler runs it after the model tick has
 * ended (systemd `ExecStartPost=`, a second launchd step), and it is the only
 * thing in the overnight pipeline that pushes. Three gates, all enforced in
 * code rather than by convention:
 *
 * 1. The push target is resolved from the worktree's actual remotes: the one
 *    whose parsed URL owner equals the authenticated login. Remote names are
 *    never trusted.
 * 2. That repo must be a fork (`GET /repos/{owner}/{repo}` says `fork: true`),
 *    so the user's own source repos never grow `prep/*` branches.
 * 3. The ref is always `refs/heads/prep/<branch>` and never `--force`; a
 *    non-fast-forward is a skip with a reason.
 *
 * With `OSS_AUTOPILOT_HANDOFF_DIR` set the tick ran as another user, and the
 * branches arrive as bundles (overnight-handoff.ts). Then there is no
 * worktree to read remotes from: the target is the PR's head repo (or
 * `<login>/<repo>` for an issue), which must also be a fork of the PR's repo,
 * and the push goes out of a private repo filled from the bundle.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  errorMessage,
  getOctokit,
  getStateManager,
  isRateLimitError,
  maybeCheckpoint,
  parseGitHubUrl,
  requireGitHubToken,
} from '../core/index.js';
import { assertAttended } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { getReportsDir } from '../core/paths.js';
import type { OvernightPrepared, OvernightRecord } from '../core/types.js';
import { handoffDir, importHandoffBundle, loadHandoff } from './overnight-handoff.js';
import { publishReport, reportDateFor, writePreparedSection } from './overnight.js';

const MODULE = 'overnight-push-prep';

/** The only ref namespace this command ever pushes to. */
export const PREP_REF_PREFIX = 'refs/heads/prep/';

const GIT_TIMEOUT_MS = 60_000;

export interface RemoteOwnerRepo {
  owner: string;
  repo: string;
}

export interface GitRemote {
  name: string;
  url: string;
}

export interface PushTarget extends RemoteOwnerRepo {
  /** Remote name in the worktree, or the fork's URL in handoff mode. */
  remote: string;
}

interface PullHead {
  ref: string;
  repo: { name: string; full_name: string; owner: { login: string } } | null;
}

/** `skipped`: a gate said no, nothing to fix tonight. `failed`: the push itself broke; the CLI exits 1. */
export type PushPrepStatus = 'pushed' | 'planned' | 'skipped' | 'failed';

export interface PushPrepResult {
  url: string;
  branch: string;
  status: PushPrepStatus;
  /** Remote name, `owner/repo`, full ref and compare URL; set once a target resolved. */
  remote?: string;
  repo?: string;
  ref?: string;
  compareUrl?: string;
  /** Why a `skipped` or `failed` entry was not pushed. */
  reason?: string;
}

export interface OvernightPushPrepOutput {
  dryRun: boolean;
  /** Authenticated login every remote owner was compared against. */
  login: string;
  reportPath: string;
  results: PushPrepResult[];
  pushed: number;
  planned: number;
  skipped: number;
  failed: number;
  /** The report file was missing and has been recreated with only the prepared section. */
  reportRecreated?: true;
  /** The pushes and state are recorded, but the report file could not be rewritten. */
  reportWarning?: string;
  gistSyncWarning?: string;
}

export interface OvernightPushPrepOptions {
  dryRun: boolean;
}

/** A ref outside `prep/` reached the push gate: a programming error, so the run stops instead of skipping. */
export class PrepNamespaceError extends Error {
  constructor(ref: string) {
    super(`Internal error: refusing to push ref "${ref}" outside ${PREP_REF_PREFIX}`);
    this.name = 'PrepNamespaceError';
  }
}

// https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com(:port)/o/r(.git);
// owner and repo use the same character classes as urls.ts.
const REMOTE_URL_PATTERN =
  /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(?::\d+)?\/)([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

/** Pure: owner/repo from a GitHub remote URL (https, scp-style ssh, ssh://); null for anything else. */
export function parseRemoteOwner(url: string): RemoteOwnerRepo | null {
  const m = url.trim().match(REMOTE_URL_PATTERN);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Pure: `git remote -v` output to one push URL per remote name. */
export function parseRemotesOutput(stdout: string): GitRemote[] {
  const remotes: GitRemote[] = [];
  for (const line of stdout.split('\n')) {
    const m = line.match(/^(\S+)\s+(\S+)\s+\(push\)$/);
    if (m) remotes.push({ name: m[1], url: m[2] });
  }
  return remotes;
}

/**
 * Pure: the first remote whose parsed URL owner equals `login`. Equality is
 * case-insensitive on the parsed owner, never a substring match, so a remote
 * for `<login>-mirror` or `org/<login>` does not qualify.
 */
export function resolvePushRemote(remotes: GitRemote[], login: string): PushTarget | null {
  // `git push <name>` pushes to EVERY push URL of that remote, so a name with
  // more than one (`git remote set-url --add --push`) can never qualify:
  // validating the first URL would say nothing about the others.
  const pushUrlCount = new Map<string, number>();
  for (const r of remotes) pushUrlCount.set(r.name, (pushUrlCount.get(r.name) ?? 0) + 1);
  for (const r of remotes) {
    // A remote named like an option would reach git's argv; never pick one.
    if (r.name.startsWith('-')) continue;
    if (pushUrlCount.get(r.name) !== 1) continue;
    const parsed = parseRemoteOwner(r.url);
    if (parsed && parsed.owner.toLowerCase() === login.toLowerCase()) return { remote: r.name, ...parsed };
  }
  return null;
}

/** The last gate before `git push`. */
function assertPrepRef(ref: string): void {
  if (!ref.startsWith(PREP_REF_PREFIX) || ref.length === PREP_REF_PREFIX.length) throw new PrepNamespaceError(ref);
}

/**
 * Pure: the full ref for a prepared branch. Built by prefixing a constant, so
 * a ref outside `prep/` cannot be produced; anything git would reject or that
 * could escape the namespace (`..`, a leading `/`, refspec separators) throws
 * instead of being pushed.
 */
export function buildPrepRef(branch: string): string {
  if (
    branch.length === 0 ||
    branch.startsWith('/') ||
    branch.endsWith('/') ||
    branch.endsWith('.lock') ||
    branch.includes('//') ||
    branch.includes('..') ||
    branch.includes('@{') ||
    /[\s~^:?*[\\]/.test(branch) ||
    [...branch].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  ) {
    throw new Error(`Refusing to build a prep ref from branch "${branch}": not a valid ref name`);
  }
  const ref = `${PREP_REF_PREFIX}${branch}`;
  assertPrepRef(ref);
  return ref;
}

/** Pure: the branch name on the fork (`prep/<branch>`) for a full prep ref. */
export function prepBranchName(ref: string): string {
  assertPrepRef(ref);
  return ref.slice('refs/heads/'.length);
}

/** Pure: `<fork>/compare/<pr-head>...prep/<branch>`. */
export function compareUrlFor(target: RemoteOwnerRepo, prHead: string, prepBranch: string): string {
  return `https://github.com/${target.owner}/${target.repo}/compare/${prHead}...${prepBranch}`;
}

function git(worktree: string, args: string[]): string {
  return execFileSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Unattended: a credential prompt must fail, not hang until the timeout.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
}

function gitStderr(err: unknown): string {
  const stderr = (err as { stderr?: unknown })?.stderr;
  return typeof stderr === 'string' ? stderr.trim() : '';
}

// Only git's two non-fast-forward hints. A bare `[rejected]` also covers
// stale-info and hook rejections, which are failures, not divergence.
function isNonFastForward(err: unknown): boolean {
  return /non-fast-forward|fetch first/.test(gitStderr(err));
}

/** errorMessage alone is "Command failed: git ..."; git's own last lines say why (auth, hook, timeout). */
function pushFailureReason(err: unknown): string {
  const timedOut = (err as { code?: unknown })?.code === 'ETIMEDOUT';
  const tail = gitStderr(err).split('\n').slice(-3).join(' | ');
  const why = timedOut
    ? `timed out after ${GIT_TIMEOUT_MS / 1000}s (the ref may still have landed; the next run re-checks)`
    : errorMessage(err);
  return `push failed: ${why}${tail ? ` [git: ${tail}]` : ''}`;
}

function notPushed(
  status: 'skipped' | 'failed',
  entry: OvernightPrepared,
  reason: string,
  target?: PushTarget,
  ref?: string,
): PushPrepResult {
  warn(MODULE, `${status === 'failed' ? 'Failed' : 'Skipping'} ${entry.branch} for ${entry.url}: ${reason}`);
  return {
    url: entry.url,
    branch: entry.branch,
    status,
    ...(target ? { remote: target.remote, repo: `${target.owner}/${target.repo}` } : {}),
    ...(ref ? { ref } : {}),
    reason,
  };
}

function skip(entry: OvernightPrepared, reason: string, target?: PushTarget, ref?: string): PushPrepResult {
  return notPushed('skipped', entry, reason, target, ref);
}

/** Push every prepared branch of the latest overnight run to `prep/*` on the user's fork. */
export async function runOvernightPushPrep(options: OvernightPushPrepOptions): Promise<OvernightPushPrepOutput> {
  // A scheduler runs this after the model tick has ended, in its own
  // environment. Inside the tick it must not run at all.
  assertAttended('push prepared branches');
  const sm = getStateManager();
  const dropDir = handoffDir();
  const handoff = dropDir ? loadHandoff(dropDir) : null;
  const last: OvernightRecord | undefined = handoff
    ? {
        ...handoff.record,
        reportPath: path.join(getReportsDir(), `overnight-${reportDateFor(new Date(handoff.record.runAt))}.md`),
      }
    : sm.getLastOvernight();
  if (!last) throw new Error('No overnight run recorded yet; run `overnight` first.');
  const lastRun = last; // narrowed binding for the closures below
  if (handoff?.report != null && !options.dryRun) fs.writeFileSync(lastRun.reportPath, handoff.report, { mode: 0o600 });

  const octokit = getOctokit(requireGitHubToken());
  const { data: viewer } = await octokit.users.getAuthenticated();
  const login = viewer.login?.trim();
  if (!login) throw new Error('Could not read the authenticated login from the token; refusing to push anywhere.');
  const configured = sm.getState().config.githubUsername;
  if (configured && configured.toLowerCase() !== login.toLowerCase()) {
    throw new Error(
      `Configured githubUsername "${configured}" does not match the token's login "${login}"; refusing to push anywhere.`,
    );
  }

  // One repo lookup per repo, not per entry.
  const forkVerdicts = new Map<string, string | null>();
  /**
   * Skip reason when `target` is not a fork the login owns, or could not be
   * read; null when it is. The live owner is checked as well as the URL's:
   * GitHub redirects a transferred or renamed repo, so a stale
   * `github.com/<login>/<repo>` URL can resolve to someone else's repo.
   */
  async function forkSkipReason(target: RemoteOwnerRepo, upstream?: string): Promise<string | null> {
    const key = `${target.owner}/${target.repo}|${upstream ?? ''}`.toLowerCase();
    const cached = forkVerdicts.get(key);
    if (cached !== undefined) return cached;
    let reason: string | null;
    try {
      const { data } = await octokit.repos.get({ owner: target.owner, repo: target.repo });
      if (!data.fork) reason = `${target.owner}/${target.repo} is not a fork`;
      else if (data.owner.login.toLowerCase() !== login.toLowerCase())
        reason = `${target.owner}/${target.repo} resolved to ${data.full_name}, not owned by ${login}`;
      else if (upstream && data.parent?.full_name?.toLowerCase() !== upstream.toLowerCase())
        reason = `${data.full_name} is not a fork of ${upstream}`;
      else reason = null;
    } catch (err) {
      // Same convention as the rest of core (errors.ts): a rate limit must
      // propagate, or every entry repeats the doomed call and the run reads
      // as "all skipped".
      if (isRateLimitError(err)) throw err;
      reason = `could not read ${target.owner}/${target.repo}: ${errorMessage(err)}`;
    }
    forkVerdicts.set(key, reason);
    return reason;
  }

  const pulls = new Map<string, Promise<PullHead | undefined>>();
  /** The PR's head (branch and repo), read once per URL; undefined (with a warning) when it cannot be read. */
  function pullFor(url: string): Promise<PullHead | undefined> {
    const parsed = parseGitHubUrl(url);
    if (!parsed || parsed.type !== 'pull') return Promise.resolve(undefined);
    let pending = pulls.get(url);
    if (!pending) {
      pending = octokit.pulls
        .get({ owner: parsed.owner, repo: parsed.repo, pull_number: parsed.number })
        .then(({ data }) => data.head as PullHead)
        .catch((err: unknown) => {
          if (isRateLimitError(err)) throw err;
          warn(MODULE, `Could not read the head of ${url}: ${errorMessage(err)}`);
          return undefined;
        });
      pulls.set(url, pending);
    }
    return pending;
  }

  /** Handoff mode: push to the PR's head repo, or `<login>/<repo>` for an issue; a string is a skip reason. */
  async function handoffTarget(url: string): Promise<{ target: PushTarget; upstream: string } | string> {
    const parsed = parseGitHubUrl(url);
    if (!parsed) return `${url} is not a GitHub PR or issue URL`;
    const upstream = `${parsed.owner}/${parsed.repo}`;
    let owner = login;
    let repo = parsed.repo;
    if (parsed.type === 'pull') {
      const head = (await pullFor(url))?.repo;
      if (!head) return `could not read the head repository of ${url}`;
      if (head.owner.login.toLowerCase() !== login.toLowerCase())
        return `the head of ${url} is ${head.full_name}, not a repo owned by ${login}`;
      owner = head.owner.login;
      repo = head.name;
    }
    return { target: { owner, repo, remote: `https://github.com/${owner}/${repo}.git` }, upstream };
  }

  async function pushOne(entry: OvernightPrepared): Promise<PushPrepResult> {
    let target: PushTarget;
    let upstream: string | undefined;
    if (dropDir) {
      const resolved = await handoffTarget(entry.url);
      if (typeof resolved === 'string') return skip(entry, resolved);
      ({ target, upstream } = resolved);
    } else {
      if (!entry.worktree) return skip(entry, 'no worktree recorded');
      if (!fs.existsSync(entry.worktree)) return skip(entry, `worktree ${entry.worktree} does not exist`);
      const found = resolvePushRemote(parseRemotesOutput(git(entry.worktree, ['remote', '-v'])), login);
      if (!found) return skip(entry, `no remote in ${entry.worktree} is owned by ${login}`);
      target = found;
    }

    const notFork = await forkSkipReason(target, upstream);
    if (notFork) return skip(entry, notFork, target);

    // A recorded name git would reject is a gate saying no, not a broken push.
    let ref: string;
    try {
      ref = buildPrepRef(entry.branch);
    } catch (err) {
      if (err instanceof PrepNamespaceError) throw err;
      return skip(entry, errorMessage(err), target);
    }
    const prepBranch = prepBranchName(ref);
    const head = (await pullFor(entry.url))?.ref;
    const base = {
      url: entry.url,
      branch: entry.branch,
      remote: target.remote,
      repo: `${target.owner}/${target.repo}`,
      ref,
      ...(head ? { compareUrl: compareUrlFor(target, head, prepBranch) } : {}),
    };
    if (options.dryRun) return { ...base, status: 'planned' };

    // The recorded branch, not HEAD: a reused worktree may have something
    // else checked out. `--no-follow-tags` keeps a `push.followTags` config
    // from writing refs/tags/*; `--` keeps the remote name out of option
    // parsing.
    assertPrepRef(ref);
    // Handoff: push out of a private repo filled from the bundle, never out
    // of anything the tick can write. A bundle that cannot be imported is a
    // failure (the tick recorded a branch it did not deliver), not a gate.
    let source: { repo: string; cleanup: () => void };
    try {
      source = dropDir ? importHandoffBundle(dropDir, entry.branch) : { repo: entry.worktree!, cleanup: () => {} };
    } catch (err) {
      return notPushed('failed', entry, `bundle import failed: ${errorMessage(err)}`, target, ref);
    }
    try {
      git(source.repo, ['push', '--no-follow-tags', '--', target.remote, `refs/heads/${entry.branch}:${ref}`]);
    } catch (err) {
      return isNonFastForward(err)
        ? skip(
            entry,
            `non-fast-forward: ${prepBranch} on ${target.remote} has commits this worktree lacks; not forced`,
            target,
            ref,
          )
        : notPushed('failed', entry, pushFailureReason(err), target, ref);
    } finally {
      source.cleanup();
    }
    return { ...base, status: 'pushed' };
  }

  const results: PushPrepResult[] = [];
  // A copy of the whole list, updated in place: if the run stops early, the
  // entries it never reached are kept as they were, not dropped.
  const prepared: OvernightPrepared[] = [...last.prepared];
  let reportRecreated = false;
  let reportWarning: string | null = null;
  let gistSyncWarning: string | null = null;

  /** Record what happened so far. Runs even when the loop throws, so a ref that is live on the fork is never missing from state. */
  async function persist(): Promise<void> {
    if (options.dryRun) return;
    sm.setLastOvernight({ ...lastRun, prepared });
    try {
      reportRecreated = writePreparedSection(lastRun.reportPath, prepared).reportRecreated;
    } catch (err) {
      // State already has the pushes; a report that cannot be written must
      // not also cost the Gist checkpoint.
      reportWarning = `could not rewrite ${lastRun.reportPath}: ${errorMessage(err)}`;
      warn(MODULE, reportWarning);
    }
    // Outside the try: publishReport warns on its own and must never be
    // mistaken for a failed report write.
    if (!reportWarning) publishReport(sm, lastRun.reportPath);
    gistSyncWarning = await maybeCheckpoint(sm, MODULE);
  }

  try {
    for (const [i, entry] of last.prepared.entries()) {
      let result: PushPrepResult;
      try {
        result = await pushOne(entry);
      } catch (err) {
        if (err instanceof PrepNamespaceError || isRateLimitError(err)) throw err;
        result = notPushed('failed', entry, errorMessage(err));
      }
      results.push(result);
      if (result.status === 'pushed' && result.ref) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { pushProblem: _cleared, ...rest } = entry;
        prepared[i] = {
          ...rest,
          pushedRef: prepBranchName(result.ref),
          pushedAt: new Date().toISOString(),
          ...(result.compareUrl ? { compareUrl: result.compareUrl } : {}),
        };
      } else if (result.status !== 'planned' && result.reason) {
        prepared[i] = { ...entry, pushProblem: result.reason };
      }
    }
  } finally {
    await persist();
  }

  const count = (status: PushPrepStatus) => results.filter((r) => r.status === status).length;
  return {
    dryRun: options.dryRun,
    login,
    reportPath: last.reportPath,
    results,
    pushed: count('pushed'),
    planned: count('planned'),
    skipped: count('skipped'),
    failed: count('failed'),
    ...(reportRecreated ? { reportRecreated: true as const } : {}),
    ...(reportWarning ? { reportWarning } : {}),
    ...(gistSyncWarning ? { gistSyncWarning } : {}),
  };
}

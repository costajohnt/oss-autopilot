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
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  errorMessage,
  getOctokit,
  getStateManager,
  maybeCheckpoint,
  parseGitHubUrl,
  requireGitHubToken,
} from '../core/index.js';
import { warn } from '../core/logger.js';
import type { OvernightPrepared } from '../core/types.js';
import { writePreparedSection } from './overnight.js';

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
  remote: string;
}

export type PushPrepStatus = 'pushed' | 'planned' | 'skipped';

export interface PushPrepResult {
  url: string;
  branch: string;
  status: PushPrepStatus;
  /** Remote name, `owner/repo`, full ref and compare URL; set once a target resolved. */
  remote?: string;
  repo?: string;
  ref?: string;
  compareUrl?: string;
  /** Why a `skipped` entry was not pushed. */
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
  for (const r of remotes) {
    // A remote named like an option would reach git's argv; never pick one.
    if (r.name.startsWith('-')) continue;
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

function isNonFastForward(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  return typeof stderr === 'string' && /non-fast-forward|fetch first|\[rejected\]/.test(stderr);
}

function skip(entry: OvernightPrepared, reason: string, target?: PushTarget, ref?: string): PushPrepResult {
  warn(MODULE, `Skipping ${entry.branch} for ${entry.url}: ${reason}`);
  return {
    url: entry.url,
    branch: entry.branch,
    status: 'skipped',
    ...(target ? { remote: target.remote, repo: `${target.owner}/${target.repo}` } : {}),
    ...(ref ? { ref } : {}),
    reason,
  };
}

/** Push every prepared branch of the latest overnight run to `prep/*` on the user's fork. */
export async function runOvernightPushPrep(options: OvernightPushPrepOptions): Promise<OvernightPushPrepOutput> {
  const sm = getStateManager();
  const last = sm.getLastOvernight();
  if (!last) throw new Error('No overnight run recorded yet; run `overnight` first.');

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
  async function forkSkipReason(target: RemoteOwnerRepo): Promise<string | null> {
    const key = `${target.owner}/${target.repo}`.toLowerCase();
    const cached = forkVerdicts.get(key);
    if (cached !== undefined) return cached;
    let reason: string | null;
    try {
      const { data } = await octokit.repos.get({ owner: target.owner, repo: target.repo });
      if (!data.fork) reason = `${target.owner}/${target.repo} is not a fork`;
      else if (data.owner.login.toLowerCase() !== login.toLowerCase())
        reason = `${target.owner}/${target.repo} resolved to ${data.full_name}, not owned by ${login}`;
      else reason = null;
    } catch (err) {
      reason = `could not read ${target.owner}/${target.repo}: ${errorMessage(err)}`;
    }
    forkVerdicts.set(key, reason);
    return reason;
  }

  /** PR head branch for the compare URL; undefined (with a warning) when it cannot be read. */
  async function prHeadFor(url: string): Promise<string | undefined> {
    const parsed = parseGitHubUrl(url);
    if (!parsed || parsed.type !== 'pull') return undefined;
    try {
      const { data } = await octokit.pulls.get({ owner: parsed.owner, repo: parsed.repo, pull_number: parsed.number });
      return data.head.ref;
    } catch (err) {
      warn(MODULE, `Could not read the head branch of ${url}; no compare URL: ${errorMessage(err)}`);
      return undefined;
    }
  }

  async function pushOne(entry: OvernightPrepared): Promise<PushPrepResult> {
    if (!entry.worktree) return skip(entry, 'no worktree recorded');
    if (!fs.existsSync(entry.worktree)) return skip(entry, `worktree ${entry.worktree} does not exist`);

    const target = resolvePushRemote(parseRemotesOutput(git(entry.worktree, ['remote', '-v'])), login);
    if (!target) return skip(entry, `no remote in ${entry.worktree} is owned by ${login}`);

    const notFork = await forkSkipReason(target);
    if (notFork) return skip(entry, notFork, target);

    const ref = buildPrepRef(entry.branch);
    const prepBranch = prepBranchName(ref);
    const head = await prHeadFor(entry.url);
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
    try {
      git(entry.worktree, ['push', '--no-follow-tags', '--', target.remote, `refs/heads/${entry.branch}:${ref}`]);
    } catch (err) {
      return isNonFastForward(err)
        ? skip(
            entry,
            `non-fast-forward: ${prepBranch} on ${target.remote} has commits this worktree lacks; not forced`,
            target,
            ref,
          )
        : skip(entry, `push failed: ${errorMessage(err)}`, target, ref);
    }
    return { ...base, status: 'pushed' };
  }

  const results: PushPrepResult[] = [];
  const prepared: OvernightPrepared[] = [];
  for (const entry of last.prepared) {
    let result: PushPrepResult;
    try {
      result = await pushOne(entry);
    } catch (err) {
      if (err instanceof PrepNamespaceError) throw err;
      result = skip(entry, errorMessage(err));
    }
    results.push(result);
    prepared.push(
      result.status === 'pushed' && result.ref
        ? {
            ...entry,
            pushedRef: prepBranchName(result.ref),
            pushedAt: new Date().toISOString(),
            ...(result.compareUrl ? { compareUrl: result.compareUrl } : {}),
          }
        : entry,
    );
  }

  let gistSyncWarning: string | null = null;
  if (!options.dryRun) {
    sm.setLastOvernight({ ...last, prepared });
    writePreparedSection(last.reportPath, prepared);
    gistSyncWarning = await maybeCheckpoint(sm, MODULE);
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
    ...(gistSyncWarning ? { gistSyncWarning } : {}),
  };
}

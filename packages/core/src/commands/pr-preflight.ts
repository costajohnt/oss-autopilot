/**
 * pr-preflight command (#1952): one gate before a branch is pushed and a PR
 * is opened. Gathers facts from the local clone (read-only commands) and from
 * GitHub (read-only API), then runs the pure checks in core/pr-preflight.ts:
 * upstream drift, base branch, head branch, working tree, competing work on
 * the issue, and the per-repo open-PR cap.
 *
 * It only reads, so it runs in unattended mode. Without a GitHub token, or
 * with `--local`, the local checks still run and the network checks come back
 * `skipped`; a GitHub read that fails degrades its own check only. The one
 * thing it can change is remote-tracking refs, and only when `--fetch` is
 * passed; without it a stale `<remote>/<base>` is reported, not refreshed.
 */

import type { Octokit } from '@octokit/rest';
import {
  errorMessage,
  fetchIssueVerification,
  getGitHubTokenAsync,
  getHttpStatusCode,
  getOctokit,
  getStateManager,
  parseGitHubUrl,
  splitRepo,
  type IssueVerification,
} from '../core/index.js';
import type { AgentState } from '../core/types.js';
import { ValidationError } from '../core/errors.js';
import {
  runPreflightChecks,
  type PreflightCheck,
  type PreflightFacts,
  type PreflightGitHubFacts,
  type PreflightVerdict,
} from '../core/pr-preflight.js';
import { git, parseRemoteOwner, parseRemotesOutput, resolvePushRemote, type GitRemote } from './overnight-push-prep.js';
import type { RepoCapStatus } from '../core/repo-cap.js';
import { runRepoCap } from './repo-cap.js';
import { effectivePolicy } from '../core/repo-policy.js';
import { isFirstInRepo } from '../core/pick-snapshot.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface PrPreflightOptions {
  /** Local clone or worktree; defaults to the current directory. */
  dir?: string;
  /** Issue URL, or an issue number in the upstream repository. */
  issue?: string;
  /** Branch the PR will target; defaults to the upstream default branch. */
  base?: string;
  /** Run `git fetch <remote> <base>` before measuring drift. */
  fetch: boolean;
  /** Skip every GitHub read; for callers that only want the local numbers. */
  local: boolean;
}

export interface PrPreflightOutput {
  verdict: PreflightVerdict;
  dir: string;
  repo: string | null;
  issueUrl: string | null;
  branch: string | null;
  remote: string | null;
  base: string | null;
  mergeBase: string | null;
  ahead: number | null;
  behind: number | null;
  checks: PreflightCheck[];
}

type DriftFacts = Pick<
  PreflightFacts,
  'remoteRefSha' | 'behind' | 'ahead' | 'mergeBase' | 'overlappingCommits' | 'fetchError'
>;

type FetchMode = 'fetch' | 'no-fetch';

const BRANCH_NAME = /^[\w.][\w./-]*$/;
const ISSUE_NUMBER = /^#?(\d+)$/;
const MAX_OVERLAP_LINES = 20;
// ponytail: argv ceiling. A branch touching more files than this is checked on the first 500 only.
const MAX_PATHSPECS = 500;

/** Output of a command that may legitimately fail (missing ref, unborn HEAD); null when it does. */
function tryGit(dir: string, args: string[]): string | null {
  try {
    return git(dir, args).trim();
  } catch {
    return null;
  }
}

function repoName(remote: GitRemote | null): string | null {
  const parsed = remote ? parseRemoteOwner(remote.url) : null;
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

/** The remote for `repo` when one points at it, else `upstream`, else `origin`, else the first. */
function pickRemote(remotes: GitRemote[], repo: string | null): GitRemote | null {
  // A remote named like an option would be read as one.
  const usable = remotes.filter((r) => !r.name.startsWith('-'));
  const wanted = repo?.toLowerCase();
  const matching = usable.find((r) => wanted !== undefined && repoName(r)?.toLowerCase() === wanted);
  const named = usable.find((r) => r.name === 'upstream') ?? usable.find((r) => r.name === 'origin');
  return matching ?? named ?? usable.at(0) ?? null;
}

function issueRepo(issue: string | undefined): string | null {
  if (issue === undefined || ISSUE_NUMBER.test(issue)) return null;
  validateUrl(issue);
  validateGitHubUrl(issue, ISSUE_URL_PATTERN, 'issue');
  const parsed = parseGitHubUrl(issue);
  if (!parsed) throw new ValidationError(`Not a parseable GitHub issue URL: ${issue}`);
  return `${parsed.owner}/${parsed.repo}`;
}

function issueUrlFor(issue: string | undefined, repo: string | null): string | null {
  if (issue === undefined) return null;
  const numbered = ISSUE_NUMBER.exec(issue);
  if (!numbered) return issue;
  if (!repo) throw new ValidationError(`No GitHub remote to resolve issue ${issue} against; pass the issue URL`);
  return `https://github.com/${repo}/issues/${numbered[1]}`;
}

async function branchHeadSha(octokit: Octokit, repo: string, branch: string): Promise<string | null> {
  try {
    const { data } = await octokit.repos.getBranch({ ...splitRepo(repo), branch });
    return data.commit.sha;
  } catch (err) {
    if (getHttpStatusCode(err) === 404) return null;
    throw err;
  }
}

async function fetchGitHubFacts(
  octokit: Octokit,
  repo: string,
  base: string | undefined,
): Promise<PreflightGitHubFacts> {
  const { data } = await octokit.repos.get(splitRepo(repo));
  return {
    defaultBranch: data.default_branch,
    parent: data.parent?.full_name ?? null,
    canPush: data.permissions?.push === true,
    baseHeadSha: await branchHeadSha(octokit, repo, base ?? data.default_branch),
  };
}

type TargetFacts = Pick<PreflightFacts, 'repo' | 'remote' | 'remoteRepo' | 'issueUrl'>;
type NetworkFacts = Pick<
  PreflightFacts,
  'networkSkip' | 'github' | 'issue' | 'cap' | 'githubError' | 'issueError' | 'capError'
>;

function offline(networkSkip: string): NetworkFacts {
  return { networkSkip, github: null, issue: null, cap: null, githubError: null, issueError: null, capError: null };
}

interface Attempt<T> {
  value: T | null;
  error: string | null;
}

const NOT_RUN = { value: null, error: null };

/** One GitHub read. A failure is recorded for its check; bad input (an issue that does not exist) still throws. */
async function attempt<T>(read: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { value: await read(), error: null };
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    return { value: null, error: errorMessage(err).split('\n', 1)[0] };
  }
}

async function gatherNetworkFacts(
  target: TargetFacts,
  options: PrPreflightOptions,
  login: string | null,
): Promise<NetworkFacts> {
  const { repo, issueUrl } = target;
  if (options.local) return offline('local mode (--local)');
  if (!repo) return offline('no remote points at a GitHub repository');
  const token = await getGitHubTokenAsync();
  if (!token) return offline('no GitHub token (run gh auth login or set GITHUB_TOKEN)');
  const octokit = getOctokit(token);
  const parsed = issueUrl ? parseGitHubUrl(issueUrl) : null;
  const github = await attempt(() => fetchGitHubFacts(octokit, repo, options.base));
  const issue: Attempt<IssueVerification> = parsed
    ? await attempt(() => fetchIssueVerification(octokit, parsed))
    : NOT_RUN;
  // The cap gates a new PR, so it runs only for an issue; its search needs the username.
  const cap: Attempt<RepoCapStatus> = parsed && login ? await attempt(() => runRepoCap({ repo })) : NOT_RUN;
  return {
    networkSkip: null,
    github: github.value,
    githubError: github.error,
    issue: issue.value,
    issueError: issue.error,
    cap: cap.value,
    capError: cap.error,
  };
}

/** `git log --oneline` lines for commits in `mergeBase..upstream` touching files changed in `mergeBase..HEAD`. */
function overlappingCommits(dir: string, mergeBase: string, upstream: string): string[] {
  const files = git(dir, ['diff', '--name-only', '-z', mergeBase, 'HEAD'])
    .split('\0')
    .filter((file) => file !== '');
  if (files.length === 0) return [];
  const range = `${mergeBase}..${upstream}`;
  const limit = `--max-count=${MAX_OVERLAP_LINES}`;
  const log = git(dir, [
    '--literal-pathspecs',
    'log',
    '--oneline',
    limit,
    range,
    '--',
    ...files.slice(0, MAX_PATHSPECS),
  ]);
  return log.split('\n').filter((line) => line !== '');
}

/**
 * Fetch the target branch into its remote-tracking ref, the only thing this command ever changes.
 * The full refspec keeps a branch name from being read as an option. Returns the failure, or null.
 */
function fetchBase(dir: string, remote: string, base: string): string | null {
  try {
    git(dir, ['fetch', '--quiet', remote, `+refs/heads/${base}:refs/remotes/${remote}/${base}`]);
    return null;
  } catch (err) {
    return errorMessage(err).split('\n', 1)[0];
  }
}

function gatherDriftFacts(dir: string, remote: string | null, base: string | null, mode: FetchMode): DriftFacts {
  const none = { remoteRefSha: null, behind: null, ahead: null, mergeBase: null, overlappingCommits: [] };
  if (!remote || !base) return { ...none, fetchError: null };
  const fetchError = mode === 'fetch' ? fetchBase(dir, remote, base) : null;
  const remoteRefSha = tryGit(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${base}`]);
  const counts = remoteRefSha ? tryGit(dir, ['rev-list', '--left-right', '--count', `${remoteRefSha}...HEAD`]) : null;
  if (!remoteRefSha || !counts) return { ...none, remoteRefSha, fetchError };
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  const mergeBase = tryGit(dir, ['merge-base', remoteRefSha, 'HEAD']);
  return {
    remoteRefSha,
    behind,
    ahead,
    mergeBase,
    fetchError,
    overlappingCommits: mergeBase ? overlappingCommits(dir, mergeBase, remoteRefSha) : [],
  };
}

/**
 * The default branch the clone records for the remote. A remote added by hand has no `HEAD`, so
 * `origin`'s is the fallback: a fork almost always keeps its parent's default branch name.
 */
function localDefaultBranch(dir: string, remote: string | null): string | null {
  if (!remote) return null;
  const names = new Set([remote, 'origin']);
  for (const name of names) {
    const head = tryGit(dir, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${name}/HEAD`]);
    if (head) return head.slice(name.length + 1);
  }
  return null;
}

function repoRoot(dir: string): string {
  const root = tryGit(dir, ['rev-parse', '--show-toplevel']);
  if (!root) throw new ValidationError(`Not a git working tree: ${dir}`);
  return root;
}

/** Which repository the PR goes to and which remote stands for it. */
function resolveTarget(remotes: GitRemote[], issue: string | undefined): TargetFacts {
  const fromIssue = issueRepo(issue);
  const remote = pickRemote(remotes, fromIssue);
  const remoteRepo = repoName(remote);
  const repo = fromIssue ?? remoteRepo;
  return { repo, remoteRepo, remote: remote?.name ?? null, issueUrl: issueUrlFor(issue, repo) };
}

type HeadFacts = Pick<PreflightFacts, 'branch' | 'dirtyCount' | 'login' | 'pushRemote'>;

function gatherHeadFacts(dir: string, remotes: GitRemote[], login: string | null): HeadFacts {
  const pushTarget = login ? resolvePushRemote(remotes, login) : null;
  const status = git(dir, ['status', '--porcelain']);
  return {
    login,
    branch: tryGit(dir, ['branch', '--show-current']) || null,
    dirtyCount: status.split('\n').filter((line) => line !== '').length,
    pushRemote: pushTarget?.remote ?? null,
  };
}

function repoScoreFor(state: Readonly<AgentState>, repo: string): AgentState['repoScores'][string] | undefined {
  const lower = repo.toLowerCase();
  return Object.entries(state.repoScores).find(([key]) => key.toLowerCase() === lower)?.[1];
}

/** The repo's contribution policy and whether this is the user's first PR there; read from local state only. */
function policyFacts(
  state: Readonly<AgentState>,
  repo: string | null,
): Pick<PreflightFacts, 'policy' | 'isFirstContribution'> {
  if (!repo) return { policy: null, isFirstContribution: false };
  return {
    policy: effectivePolicy(state, repo),
    // State keys keep the casing of the URL they came from; the remote may differ.
    isFirstContribution: isFirstInRepo(repo, repoScoreFor(state, repo), state.mergedPRs),
  };
}

/** Run every preflight check for the branch checked out in `options.dir`. */
export async function runPrPreflight(options: PrPreflightOptions): Promise<PrPreflightOutput> {
  if (options.base !== undefined && !BRANCH_NAME.test(options.base)) {
    throw new ValidationError(`Invalid base branch name: ${options.base}`);
  }
  const dir = repoRoot(options.dir ?? process.cwd());
  const remotes = parseRemotesOutput(git(dir, ['remote', '-v']));
  const target = resolveTarget(remotes, options.issue);
  const sm = getStateManager();
  const login = sm.getState().config.githubUsername || null;
  const network = await gatherNetworkFacts(target, options, login);
  const localDefault = localDefaultBranch(dir, target.remote);
  const base = options.base ?? network.github?.defaultBranch ?? localDefault;
  const facts: PreflightFacts = {
    ...target,
    ...network,
    ...gatherHeadFacts(dir, remotes, login),
    ...gatherDriftFacts(dir, target.remote, base, options.fetch ? 'fetch' : 'no-fetch'),
    base,
    localDefault,
    ...policyFacts(sm.getState(), target.repo),
  };
  const { repo, remote, issueUrl, branch, mergeBase, ahead, behind } = facts;
  const result = runPreflightChecks(facts);
  return { ...result, dir, repo, issueUrl, branch, remote, base, mergeBase, ahead, behind };
}

/** Text mode: the verdict, then one line per check. */
export function printPrPreflight(data: PrPreflightOutput): void {
  const target = `${data.branch ?? '(detached HEAD)'} -> ${data.repo ?? '(no GitHub remote)'}:${data.base ?? '?'}`;
  console.log(`\nPR preflight: ${data.verdict.toUpperCase()}  ${target}`);
  for (const check of data.checks) {
    console.log(`  [${check.status}] ${check.id}: ${check.summary}`);
  }
}

/**
 * PR preflight checks (#1952): the gate that runs before a branch is pushed
 * and a PR is opened in someone else's repository.
 *
 * Every check is a pure function over `PreflightFacts`, which the
 * `pr-preflight` command gathers from the local clone and read-only GitHub calls.
 * A new check is one more function in `PREFLIGHT_CHECKS` (plus the facts it
 * needs); the verdict and the output shape do not change.
 */

import type { IssueAvailabilityVerdict, IssueVerification } from './issue-verification.js';
import type { RepoCapStatus } from './repo-cap.js';
import { isOwnRepo, splitRepo } from './urls.js';

export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type PreflightVerdict = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  /** One line a user can read. */
  summary: string;
  /** The facts behind the status. Commit subjects in it are untrusted text. */
  details?: Record<string, unknown>;
}

/** What GitHub says about the upstream repository; absent without a token. */
export interface PreflightGitHubFacts {
  defaultBranch: string;
  /** `owner/repo` the upstream repository was forked from, or null. */
  parent: string | null;
  /** The token can push to the upstream repository. */
  canPush: boolean;
  /** Head commit of the target branch on GitHub; null when the branch does not exist there. */
  baseHeadSha: string | null;
}

export interface PreflightFacts {
  /** Upstream `owner/repo`: from the issue URL, else from the remote. Null when neither names a GitHub repository. */
  repo: string | null;
  /** Remote the drift is measured against; null when the clone has none. */
  remote: string | null;
  /** `owner/repo` that remote's URL points at. */
  remoteRepo: string | null;
  /** Current branch; null on a detached HEAD. */
  branch: string | null;
  /** Branch the PR will target: `--base`, else the default branch. */
  base: string | null;
  /** Default branch the clone records for the remote (`refs/remotes/<remote>/HEAD`). */
  localDefault: string | null;
  /** Entries in `git status --porcelain`. */
  dirtyCount: number;
  /** Commit the local `<remote>/<base>` ref points at; null when it is not fetched. */
  remoteRefSha: string | null;
  behind: number | null;
  ahead: number | null;
  mergeBase: string | null;
  /** `git log --oneline` lines for upstream commits since the merge base that touch files this branch changed. */
  overlappingCommits: string[];
  /** Set when `--fetch` was passed and the fetch failed. */
  fetchError: string | null;
  /** Configured GitHub username. */
  login: string | null;
  /** Remote whose URL owner is `login`. */
  pushRemote: string | null;
  issueUrl: string | null;
  /** Why GitHub was not consulted; null when it was. */
  networkSkip: string | null;
  github: PreflightGitHubFacts | null;
  issue: IssueVerification | null;
  cap: RepoCapStatus | null;
}

/** Past this many commits behind, the drift check warns even when no upstream commit touches the branch's files. */
export const BEHIND_WARN_THRESHOLD = 20;

function check(
  id: string,
  status: PreflightStatus,
  summary: string,
  details?: Record<string, unknown>,
): PreflightCheck {
  return details ? { id, status, summary, details } : { id, status, summary };
}

function driftSummary(facts: PreflightFacts, ref: string, behind: number): Pick<PreflightCheck, 'status' | 'summary'> {
  if (facts.fetchError !== null) {
    return { status: 'warn', summary: `git fetch failed (${facts.fetchError}); ${ref} may be stale` };
  }
  const upstreamSha = facts.github?.baseHeadSha;
  if (upstreamSha && upstreamSha !== facts.remoteRefSha) {
    return {
      status: 'warn',
      summary: `${ref} is stale (GitHub is at ${upstreamSha.slice(0, 9)}), so ${behind} behind is a lower bound; run again with --fetch`,
    };
  }
  if (facts.overlappingCommits.length > 0) {
    return {
      status: 'warn',
      summary: `${facts.overlappingCommits.length} commit(s) on ${ref} since the branch point touch files this branch changes; the same fix may have landed`,
    };
  }
  if (behind > BEHIND_WARN_THRESHOLD) {
    return { status: 'warn', summary: `${behind} commits behind ${ref}; rebase to lower the conflict risk` };
  }
  const unverified = facts.github
    ? ''
    : ` (freshness of ${ref} not verified: ${facts.networkSkip ?? 'no GitHub data'})`;
  const position =
    behind === 0 ? `up to date with ${ref}` : `${behind} commit(s) behind ${ref}, none touching this branch's files`;
  return { status: 'pass', summary: position + unverified };
}

/** Commits on the upstream target branch that this branch does not have. Never fetches: a stale ref is reported. */
export function checkDrift(facts: PreflightFacts): PreflightCheck {
  const id = 'upstream-drift';
  if (!facts.remote) return check(id, 'warn', 'no git remote to compare against');
  if (!facts.base) return check(id, 'warn', 'could not determine the default branch; pass --base <branch>');
  const ref = `${facts.remote}/${facts.base}`;
  if (facts.remoteRefSha === null || facts.behind === null) {
    const why = facts.fetchError === null ? '' : ` (git fetch failed: ${facts.fetchError})`;
    return check(id, 'warn', `${ref} is not fetched locally${why}; run again with --fetch`);
  }
  const { status, summary } = driftSummary(facts, ref, facts.behind);
  return check(id, status, summary, {
    ref,
    behind: facts.behind,
    ahead: facts.ahead,
    mergeBase: facts.mergeBase,
    overlappingCommits: facts.overlappingCommits,
  });
}

function isSameRepo(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && a.toLowerCase() === b.toLowerCase();
}

type Finding = Pick<PreflightCheck, 'status' | 'summary'>;

/** The target branch is missing upstream or is not the default branch. */
function baseTargetProblem(repo: string, base: string, github: PreflightGitHubFacts): Finding | null {
  const { defaultBranch } = github;
  if (github.baseHeadSha === null) {
    return { status: 'fail', summary: `branch ${base} does not exist on ${repo} (default branch: ${defaultBranch})` };
  }
  if (base === defaultBranch) return null;
  return {
    status: 'warn',
    summary: `the PR would target ${base}, not ${defaultBranch}, the default branch of ${repo}; right only if the contribution guide says so`,
  };
}

/** The clone does not line up with the upstream repository: wrong repository, wrong remote, renamed default branch. */
function baseCloneProblem(facts: PreflightFacts, repo: string, github: PreflightGitHubFacts): string | null {
  if (github.parent && !facts.issueUrl) {
    return `${repo} is a fork of ${github.parent}; add a remote for the parent or pass the issue URL so the checks run against it`;
  }
  const remote = facts.remote ?? '(none)';
  if (!isSameRepo(facts.remoteRepo, repo)) {
    return `remote ${remote} does not point at ${repo}, so drift was not measured against it; add a remote for ${repo}`;
  }
  if (facts.localDefault !== null && facts.localDefault !== github.defaultBranch) {
    return `${repo} now defaults to ${github.defaultBranch} but the clone records ${facts.localDefault}; run git remote set-head ${remote} -a`;
  }
  return null;
}

/** The PR targets a branch that exists upstream and is the default branch, on the repository the remote points at. */
export function checkBaseBranch(facts: PreflightFacts): PreflightCheck {
  const id = 'base-branch';
  const { github, repo, base } = facts;
  if (!github || !repo || !base) {
    const guess = base ? `; local guess: ${base}` : '';
    return check(id, 'skipped', `${facts.networkSkip ?? 'no upstream repository'}${guess}`);
  }
  const details = { repo, base, defaultBranch: github.defaultBranch };
  const target = baseTargetProblem(repo, base, github);
  if (target) return check(id, target.status, target.summary, details);
  const clone = baseCloneProblem(facts, repo, github);
  if (clone) return check(id, 'warn', clone, details);
  return check(id, 'pass', `targets ${base}, the default branch of ${repo}`, details);
}

/** The head is a real feature branch, and the user has somewhere to push it. */
export function checkHeadBranch(facts: PreflightFacts): PreflightCheck {
  const id = 'head-branch';
  const { branch, repo, login } = facts;
  if (branch === null) return check(id, 'fail', 'detached HEAD: check out a feature branch before opening a PR');
  const defaultBranch = facts.github?.defaultBranch ?? facts.localDefault;
  if ([facts.base, defaultBranch].includes(branch)) {
    return check(id, 'fail', `on ${branch}, the branch the PR would target; create a feature branch`);
  }
  if (!login) {
    return check(id, 'warn', 'githubUsername is not configured, so no fork remote could be confirmed; run setup');
  }
  if (repo && (facts.github?.canPush || isOwnRepo(splitRepo(repo).owner, login))) {
    return check(id, 'pass', `${branch} can be pushed to ${repo} directly`);
  }
  if (facts.pushRemote) {
    return check(id, 'pass', `${branch} can be pushed to your fork (remote ${facts.pushRemote})`);
  }
  return check(id, 'warn', `no remote is owned by ${login}; fork the repository and add the fork as a remote`);
}

export function checkWorkingTree(facts: PreflightFacts): PreflightCheck {
  const id = 'working-tree';
  if (facts.dirtyCount === 0) return check(id, 'pass', 'working tree is clean');
  return check(id, 'warn', `${facts.dirtyCount} uncommitted change(s) would not be part of the PR`, {
    dirtyCount: facts.dirtyCount,
  });
}

const COMPETING_STATUS: Record<IssueAvailabilityVerdict, PreflightStatus> = {
  available: 'pass',
  'own-open-pr': 'warn',
  'at-risk': 'warn',
  taken: 'fail',
  closed: 'fail',
};

/** Someone else's open closing PR, an assignment, or a closed issue, from the same verification `verify-issue` runs. */
export function checkCompetingWork(facts: PreflightFacts): PreflightCheck {
  const id = 'competing-work';
  if (!facts.issueUrl) return check(id, 'skipped', 'no issue given');
  const { issue } = facts;
  if (!issue) return check(id, 'skipped', facts.networkSkip ?? 'the issue was not verified');
  const openPRs = issue.linkedPRs
    .filter((pr) => pr.state === 'open')
    // Titles are left out: they are untrusted text and the URL identifies the PR.
    .map((pr) => ({ number: pr.number, url: pr.url, author: pr.author, isOwn: pr.isOwn, linkType: pr.linkType }));
  return check(id, COMPETING_STATUS[issue.verdict], `${issue.verdict}: ${issue.verdictReason}`, {
    issueUrl: issue.url,
    verdict: issue.verdict,
    state: issue.state,
    assignees: issue.assignees,
    openPRs,
  });
}

/** The user's own open-PR cap and `excludeRepos`, as `repo-cap` reports them. */
export function checkRepoCap(facts: PreflightFacts): PreflightCheck {
  const id = 'repo-cap';
  const { cap } = facts;
  if (!cap) return check(id, 'skipped', facts.networkSkip ?? 'githubUsername is not configured; run setup');
  const details = { ...cap };
  if (cap.reason) return check(id, 'warn', cap.reason, details);
  const limit = cap.cap > 0 ? `of ${cap.cap} allowed` : '(no cap set)';
  return check(id, 'pass', `${cap.openPRCount} open PR(s) in ${cap.repo} ${limit}`, details);
}

/** Every check, in output order. A new check is added here. */
export const PREFLIGHT_CHECKS: ReadonlyArray<(facts: PreflightFacts) => PreflightCheck> = [
  checkDrift,
  checkBaseBranch,
  checkHeadBranch,
  checkWorkingTree,
  checkCompetingWork,
  checkRepoCap,
];

/** `fail` when any check fails, else `warn` when any warns, else `pass`. Skipped checks do not count. */
export function preflightVerdict(checks: readonly PreflightCheck[]): PreflightVerdict {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  return checks.some((c) => c.status === 'warn') ? 'warn' : 'pass';
}

export function runPreflightChecks(facts: PreflightFacts): { verdict: PreflightVerdict; checks: PreflightCheck[] } {
  const checks = PREFLIGHT_CHECKS.map((run) => run(facts));
  return { verdict: preflightVerdict(checks), checks };
}

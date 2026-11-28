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
import { banNote, fencePolicyText, quote, summarizePolicy, type RepoPolicy } from './repo-policy.js';
import { wrapUntrustedContent } from './untrusted-content.js';
import { isOwnRepo, splitRepo } from './urls.js';

export type PreflightStatus = 'pass' | 'warn' | 'fail' | 'skipped';
export type PreflightVerdict = 'pass' | 'warn' | 'fail';

export interface PreflightCheck {
  id: string;
  status: PreflightStatus;
  /** One line a user can read. */
  summary: string;
  /** The facts behind the status. Commit subjects in it arrive inside a `<github-content>` fence. */
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
  /** Full messages of this branch's own commits (`git log <mergeBase>..HEAD`, merges left out); null without a merge base. */
  branchCommits: string[] | null;
  /** Set when `--fetch` was passed and the fetch failed. */
  fetchError: string | null;
  /** Configured GitHub username. */
  login: string | null;
  /** Remote whose URL owner is `login`. */
  pushRemote: string | null;
  issueUrl: string | null;
  /** Why GitHub was not consulted at all (`--local`, no token, no GitHub remote); null when it was. */
  networkSkip: string | null;
  /** Why one GitHub read failed; that check degrades and the others still run. */
  githubError: string | null;
  issueError: string | null;
  capError: string | null;
  github: PreflightGitHubFacts | null;
  issue: IssueVerification | null;
  cap: RepoCapStatus | null;
  /** The repo's contribution policy (`effectivePolicy`: stored record plus the blocklist); null when none is recorded. */
  policy: RepoPolicy | null;
  /** The user has no merged PR in the repo. */
  isFirstContribution: boolean;
  /** The staged PR body (`--body-file`); null when none was given. */
  prBody: string | null;
  /** The issue's label names, read only for a `maintainer-label` gate; null when not read. */
  issueLabels: string[] | null;
  /** Why the label read failed. */
  labelsError: string | null;
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

/** Why a network check has nothing to judge: GitHub was not consulted, or the read failed. */
function skipReason(facts: PreflightFacts, error: string | null, fallback: string): string {
  if (facts.networkSkip !== null) return facts.networkSkip;
  return error === null ? fallback : `GitHub request failed: ${error}`;
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
    : ` (freshness of ${ref} not verified: ${skipReason(facts, facts.githubError, 'no GitHub data')})`;
  const position =
    behind === 0 ? `up to date with ${ref}` : `${behind} commit(s) behind ${ref}, none touching this branch's files`;
  return { status: 'pass', summary: position + unverified };
}

/** The measurements, or undefined when the ref is not fetched. Commit subjects are third-party text, so they are fenced. */
function driftDetails(facts: PreflightFacts, ref: string): Record<string, unknown> | undefined {
  if (facts.remoteRefSha === null || facts.behind === null) return undefined;
  const subjects = facts.overlappingCommits;
  const measured = { ref, behind: facts.behind, ahead: facts.ahead, mergeBase: facts.mergeBase };
  if (subjects.length === 0) return { ...measured, overlapCount: 0 };
  return {
    ...measured,
    overlapCount: subjects.length,
    overlappingCommits: wrapUntrustedContent(subjects.join('\n'), 'commit-subjects'),
  };
}

/**
 * Commits on the upstream target branch that this branch does not have. Never fetches: a stale ref is reported.
 * The local ref is compared with GitHub only when its remote points at the upstream repository; in a
 * fork-only clone the two are different branches, and "stale, fetch again" would never clear.
 */
export function checkDrift(facts: PreflightFacts): PreflightCheck {
  const id = 'upstream-drift';
  if (!facts.remote) return check(id, 'warn', 'no git remote to compare against');
  if (!facts.base) return check(id, 'warn', 'could not determine the default branch; pass --base <branch>');
  const ref = `${facts.remote}/${facts.base}`;
  const details = driftDetails(facts, ref);
  if (facts.repo !== null && !isSameRepo(facts.remoteRepo, facts.repo)) {
    const measured = details
      ? `drift was measured against ${ref} instead (${facts.behind} behind)`
      : 'drift was not measured';
    return check(
      id,
      'warn',
      `no remote points at ${facts.repo}, so ${measured}; add a remote for ${facts.repo}`,
      details,
    );
  }
  if (!details || facts.behind === null) {
    const why = facts.fetchError === null ? '' : ` (git fetch failed: ${facts.fetchError})`;
    return check(id, 'warn', `${ref} is not fetched locally${why}; run again with --fetch`);
  }
  const { status, summary } = driftSummary(facts, ref, facts.behind);
  return check(id, status, summary, details);
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

/** The clone does not line up with the upstream repository: wrong repository, renamed default branch. */
function baseCloneProblem(facts: PreflightFacts, repo: string, github: PreflightGitHubFacts): string | null {
  if (github.parent && !facts.issueUrl) {
    return `${repo} is a fork of ${github.parent}; add a remote for the parent or pass the issue URL so the checks run against it`;
  }
  const remote = facts.remote ?? '(none)';
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
    return check(id, 'skipped', skipReason(facts, facts.githubError, 'no upstream repository') + guess);
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
  if (branch === facts.base) {
    return check(id, 'fail', `on ${branch}, the branch the PR would target; create a feature branch`);
  }
  if (branch === (facts.github?.defaultBranch ?? facts.localDefault)) {
    return check(id, 'warn', `on ${branch}, the default branch; a PR is normally opened from a feature branch`);
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
  if (!issue && facts.issueError !== null) {
    // The duplicate-PR guard did not run: a warn, so nobody pushes on a skipped check.
    return check(id, 'warn', `could not verify the issue (${facts.issueError}); check it for competing work by hand`);
  }
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

function capSkipReason(facts: PreflightFacts): string {
  if (!facts.issueUrl) return 'no issue given (the cap gates a new PR)';
  return skipReason(facts, facts.capError, 'githubUsername is not configured; run setup');
}

/** The user's own open-PR cap and `excludeRepos`, as `repo-cap` reports them. Runs only for an issue: it gates a new PR. */
export function checkRepoCap(facts: PreflightFacts): PreflightCheck {
  const id = 'repo-cap';
  const { cap } = facts;
  if (!cap) return check(id, 'skipped', capSkipReason(facts));
  const details = { ...cap };
  if (cap.reason) return check(id, 'warn', cap.reason, details);
  const limit = cap.cap > 0 ? `of ${cap.cap} allowed` : '(no cap set)';
  return check(id, 'pass', `${cap.openPRCount} open PR(s) in ${cap.repo} ${limit}`, details);
}

/** Each rule the policy states that this PR has not met, as the action that meets it. */
function policyAsks(facts: PreflightFacts, policy: RepoPolicy, repo: string): string[] {
  const isFirst = facts.isFirstContribution;
  const login = facts.login?.toLowerCase();
  const isAssigned = (facts.issue?.assignees ?? []).some((a) => a.toLowerCase() === login);
  const rules: Array<[boolean, string]> = [
    ...disclosureAsk(facts, policy, repo),
    [
      isFirst && policy.aiPolicy === 'unknown',
      `${repo}'s AI policy is unknown and this is your first PR there: read its CONTRIBUTING and README, then record it with policy set --repo ${repo} --ai-policy <value>`,
    ],
    [
      !isAssigned && policy.prGate === 'claim-first',
      `${repo} wants the issue claimed first: comment on it and get assigned before opening the PR`,
    ],
    ...maintainerLabelAsk(facts, policy, repo),
    [isFirst && policy.cla === 'required', `${repo} requires a signed CLA: sign it when the CLA bot asks on the PR`],
    [policy.prGate === 'collaborators-only' && facts.github?.canPush !== true, collaboratorsAsk(facts, policy, repo)],
    ...maxOpenAsk(facts, policy, repo),
  ];
  return rules.filter(([applies]) => applies).map(([, ask]) => ask);
}

/** Text compared case-insensitively with whitespace collapsed, as {@link quote} stores the recorded line. */
function normalized(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim().toLowerCase();
}

/** The body contains the recorded line. A line {@link quote} cut short is matched up to the cut. */
function hasDisclosure(body: string, line: string): boolean {
  const wanted = normalized(line.endsWith('…') ? line.slice(0, -1) : line);
  return wanted !== '' && normalized(body).includes(wanted);
}

/**
 * The disclosure a `disclosure-required` repo asks for (#2040). Met when the
 * staged body (`--body-file`) contains the line the user recorded. With no
 * recorded line there is nothing to match: the agent writes one from the rule
 * quoted in `details.sources`, and recording it lets the next run check it.
 */
function disclosureAsk(facts: PreflightFacts, policy: RepoPolicy, repo: string): Array<[boolean, string]> {
  if (policy.aiPolicy !== 'disclosure-required') return [];
  const required = `${repo} requires an AI-use disclosure`;
  const line = policy.disclosureText;
  if (line === undefined) {
    const record = `policy set --repo ${repo} --ai-policy disclosure-required --disclosure-text <line>`;
    return [
      [
        true,
        `${required}: write one in the PR body that meets the rule quoted in details.sources, then record the line with ${record} so preflight can check the body for it`,
      ],
    ];
  }
  if (facts.prBody === null) {
    return [[true, `${required}: add the line in details.disclosureText to the PR body and pass it with --body-file`]];
  }
  return [
    [
      !hasDisclosure(facts.prBody, line),
      `${required}: the PR body does not contain the line in details.disclosureText`,
    ],
  ];
}

/** Labels that read as a maintainer's acceptance, and words that say a label is not one yet. */
const APPROVAL_LABELS: readonly RegExp[] = [
  /\b(?:accepted|approved|ready|triaged|confirmed)\b/i,
  /\b(?:help[\s_-]?wanted|good[\s_-]first[\s_-]issue|up[\s_-]for[\s_-]grabs)\b/i,
  /\b(?:contributions?|prs?)[\s_-]welcome\b/i,
];
const NOT_YET = /\b(?:not|needs?|awaiting|pending|waiting|un\w+)\b/i;

function isApprovalLabel(label: string): boolean {
  return APPROVAL_LABELS.some((re) => re.test(label)) && !NOT_YET.test(label);
}

/** The `maintainer-label` gate, met when the issue carries a label that reads as acceptance (#2040). */
function maintainerLabelAsk(facts: PreflightFacts, policy: RepoPolicy, repo: string): Array<[boolean, string]> {
  if (policy.prGate !== 'maintainer-label') return [];
  const wants = `${repo} wants a maintainer to accept the issue first`;
  if (!facts.issueUrl) {
    return [
      [true, `${wants}: pass the issue so preflight can read its labels, or confirm it carries their approval label`],
    ];
  }
  const labels = facts.issueLabels;
  if (labels === null) {
    const why = skipReason(facts, facts.labelsError, 'the labels were not read');
    return [
      [true, `${wants} and the issue's labels could not be read (${why}): confirm it carries their approval label`],
    ];
  }
  const found =
    labels.length === 0 ? 'the issue has no labels' : "none of the issue's labels (details.issueLabels) reads as one";
  return [
    [
      !labels.some((label) => isApprovalLabel(label)),
      `${wants} and ${found}: confirm a maintainer accepted it before opening the PR`,
    ],
  ];
}

/** The open AI-PR limit when it cannot fail: the count is unknown, or the limit was read from the docs and not reviewed. */
function maxOpenAsk(facts: PreflightFacts, policy: RepoPolicy, repo: string): Array<[boolean, string]> {
  const max = policy.maxOpenAiPRs;
  if (max === undefined) return [];
  if (!facts.cap)
    return [[true, `${repo} allows ${max} open AI-assisted PR(s): count yours there before opening another`]];
  const isOver = !policy.reviewedByUser && facts.cap.openPRCount >= max;
  const ask = `${repo}'s docs read as allowing ${max} open AI-assisted PR(s) and you have ${facts.cap.openPRCount}: wait for one to close, or record the limit with policy set --repo ${repo} --ai-policy <value> --max-open-ai-prs <n|0> if the docs were misread`;
  return [[isOver, ask]];
}

/** The warn for `collaborators-only` when it cannot fail: push access unknown, or the rule not reviewed. */
function collaboratorsAsk(facts: PreflightFacts, policy: RepoPolicy, repo: string): string {
  if (!facts.github) {
    return `${repo} only takes PRs from collaborators and push access could not be checked: confirm you are one before opening the PR`;
  }
  const record = policy.reviewedByUser ? '' : `, or record it with policy set --repo ${repo} if the docs were misread`;
  return `${repo}'s docs read as collaborators-only and you cannot push there: check the rule${record}`;
}

/** What the policy forbids outright; null when nothing does. */
function policyStop(facts: PreflightFacts, policy: RepoPolicy, repo: string): string | null {
  if (policy.aiPolicy === 'banned') {
    return `${repo} does not accept AI-assisted contributions: do not open this PR${banNote(policy, repo)}`;
  }
  // Only a rule the user confirmed, checked against known push access, stops the PR.
  if (policy.prGate === 'collaborators-only' && policy.reviewedByUser && facts.github?.canPush === false) {
    return `${repo} only takes PRs from collaborators: do not open this PR`;
  }
  // Only a limit the user confirmed stops the PR; one read from the docs warns (policyAsks).
  const max = policy.reviewedByUser ? policy.maxOpenAiPRs : undefined;
  if (max !== undefined && facts.cap && facts.cap.openPRCount >= max) {
    return `${repo} allows ${max} open AI-assisted PR(s) and you have ${facts.cap.openPRCount}: wait for one to close`;
  }
  return null;
}

function noPolicyCheck(id: string, repo: string, isFirst: boolean): PreflightCheck {
  if (!isFirst) return check(id, 'pass', `no contribution policy recorded for ${repo}`);
  return check(
    id,
    'warn',
    `no contribution policy recorded for ${repo} and this is your first PR there: vet the issue or read its CONTRIBUTING, then record it with policy set --repo ${repo}`,
  );
}

/**
 * The repo's contribution policy (#1953): `banned` fails, a rule the PR has
 * not met warns with the action that meets it. Quoted repo text arrives fenced.
 */
export function checkRepoPolicy(facts: PreflightFacts): PreflightCheck {
  const id = 'repo-policy';
  const { repo, policy } = facts;
  if (!repo) return check(id, 'skipped', 'no upstream repository');
  if (!policy) return noPolicyCheck(id, repo, facts.isFirstContribution);
  const labels = facts.issueLabels;
  const details = {
    ...summarizePolicy(policy),
    ...fencePolicyText(repo, policy),
    // Label names are set in someone else's repository: fenced like the quoted lines.
    ...(labels !== null &&
      labels.length > 0 && { issueLabels: wrapUntrustedContent(labels.join('\n'), 'issue-labels') }),
  };
  const stop = policyStop(facts, policy, repo);
  if (stop) return check(id, 'fail', stop, details);
  const asks = policyAsks(facts, policy, repo);
  if (asks.length > 0) return check(id, 'warn', asks.join('; '), details);
  return check(id, 'pass', `${repo}: AI policy ${policy.aiPolicy}, PR gate ${policy.prGate}`, details);
}

const AUTO_SUBJECT = /^(?:Revert "|Reapply "|(?:fixup|squash|amend)! )/;
/** A GitHub closing keyword, on the same line as `#12`, `owner/repo#12` or an issue URL. */
const CLOSING_KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?[ \t]+`;
const CLOSING_REFS: readonly RegExp[] = [
  new RegExp(String.raw`${CLOSING_KEYWORD}\S*#\d+`, 'i'),
  new RegExp(String.raw`${CLOSING_KEYWORD}https?://github\.com/[^/\s]+/[^/\s]+/issues/\d+`, 'i'),
];

/** Per commit rule id: true when a commit message breaks it. An id this release does not know is not checked. */
const COMMIT_RULE_BROKEN: Record<string, (message: string) => boolean> = {
  // Reverts and autosquash commits keep the subject Git wrote.
  'conventional-commits': (m) => !AUTO_SUBJECT.test(m) && !/^\w+(?:\([^)\n]*\))?!?: \S/.test(m),
  'dco-signoff': (m) => !/^Signed-off-by: .+ <[^>\n]+>\s*$/im.test(m),
  'no-closing-keyword-in-commit': (m) => CLOSING_REFS.some((re) => re.test(m)),
};

const MAX_LISTED_VIOLATIONS = 10;

/**
 * The repo's recorded commit rules over this branch's commits (local, no
 * network). A rule the user confirmed fails; one read from the docs and not
 * reviewed only warns. Commit subjects arrive fenced.
 */
export function checkCommitRules(facts: PreflightFacts): PreflightCheck {
  const id = 'commit-rules';
  const { repo, policy, branchCommits } = facts;
  const rules = (policy?.commitRules ?? []).filter((rule) => Object.hasOwn(COMMIT_RULE_BROKEN, rule));
  if (!repo || !policy || rules.length === 0) return check(id, 'skipped', 'no commit rules recorded for this repo');
  if (branchCommits === null) {
    return check(id, 'skipped', 'the branch point is unknown (target branch not fetched); run again with --fetch');
  }
  const broken = branchCommits.flatMap((message) =>
    rules
      .filter((rule) => COMMIT_RULE_BROKEN[rule](message))
      .map((rule) => `${rule}: ${quote(message.split('\n', 1)[0])}`),
  );
  if (broken.length === 0) {
    return check(id, 'pass', `${branchCommits.length} commit(s) follow ${rules.join(', ')}`, { rules });
  }
  const unreviewed = policy.reviewedByUser
    ? ''
    : ` (rules read from the repo docs, not reviewed: record them with policy set --repo ${repo} --ai-policy <value> --commit-rules <ids> if misread)`;
  return check(
    id,
    policy.reviewedByUser ? 'fail' : 'warn',
    `${broken.length} commit rule violation(s): reword those commits${unreviewed}`,
    {
      rules,
      violations: wrapUntrustedContent(broken.slice(0, MAX_LISTED_VIOLATIONS).join('\n'), 'commit-subjects'),
    },
  );
}

/** Every check, in output order. A new check is added here. */
export const PREFLIGHT_CHECKS: ReadonlyArray<(facts: PreflightFacts) => PreflightCheck> = [
  checkDrift,
  checkBaseBranch,
  checkHeadBranch,
  checkWorkingTree,
  checkCompetingWork,
  checkRepoCap,
  checkRepoPolicy,
  checkCommitRules,
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

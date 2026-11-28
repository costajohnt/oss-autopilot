/**
 * Vet command
 * Vets a specific issue before working on it via @oss-scout/core
 */

import { adaptScoutLinkedPR, buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import { type VetOutput } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';
import { gradeFromCandidate, reconcileRecommendation } from '../core/issue-grading.js';
import { repoCapField } from '../core/repo-cap.js';
import {
  banNote,
  derivePolicy,
  effectivePolicy,
  linkedPolicyDocs,
  policyField,
  quote,
  storedPolicy,
  type PolicyDoc,
  type RepoPolicy,
} from '../core/repo-policy.js';
import { decodeBase64, fetchPRTemplate } from '../core/pr-template.js';
import { recordVetPolicies } from './policy.js';
import { probePath } from './repo-vet.js';
import {
  getStateManager,
  getOctokit,
  classifyLinkedPR,
  pickSnapshotFromVet,
  persistPickSnapshots,
  fetchIssueVerification,
  RULED_OUT_VERDICTS,
  traitsFromVerification,
  isFirstInRepo,
  requireGitHubToken,
  splitRepo,
  getHttpStatusCode,
  errorMessage,
  warn,
  workClaimVetFields,
  type PickSnapshot,
} from '../core/index.js';

export { type VetOutput } from '../formatters/json.js';

interface VetOptions {
  issueUrl: string;
}

/**
 * Vet a specific GitHub issue for claimability and project health.
 *
 * @param options - Vet options
 * @param options.issueUrl - Full GitHub issue URL
 * @returns Vetting result with recommendation, health data, and check outcomes
 * @throws {ValidationError} If the URL is not a valid GitHub issue URL
 */
export async function runVet(options: VetOptions): Promise<VetOutput> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const scout = await createAutopilotScout();
  const candidate = await scout.vetIssue(options.issueUrl);

  const grade = gradeFromCandidate({
    repo: candidate.issue.repo,
    projectHealth: candidate.projectHealth,
    getRepoScore: (repo) => getStateManager().getRepoScore(repo),
  });

  const userLogin = getStateManager().getState().config.githubUsername;
  const linkedPRClassification = classifyLinkedPR({
    linkedPR: adaptScoutLinkedPR(candidate.vettingResult.linkedPR),
    userLogin,
  });

  const linkedPR = buildCandidateLinkedPR(candidate.vettingResult.linkedPR);
  const output: VetOutput = {
    issue: {
      repo: candidate.issue.repo,
      number: candidate.issue.number,
      title: candidate.issue.title,
      url: candidate.issue.url,
      labels: candidate.issue.labels,
    },
    recommendation: reconcileRecommendation(candidate.recommendation, grade),
    reasonsToApprove: candidate.reasonsToApprove,
    reasonsToSkip: candidate.reasonsToSkip,
    ...(candidate.complexityUnlocked && { complexityUnlocked: true as const }),
    projectHealth: candidate.projectHealth,
    vettingResult: publicVettingResult(candidate.vettingResult),
    antiLLMPolicy: candidate.antiLLMPolicy,
    linkedPRClassification,
    ...(linkedPR && { linkedPR }),
    slmTriage: candidate.slmTriage ?? null,
    grade,
    ...repoCapField(getStateManager().getState(), candidate.issue.repo),
    // Last: a banned policy overrides the recommendation and adds a skip reason.
    ...(await recordedPolicyFields(candidate)),
  };
  // A fix already being built somewhere (#1856) overrides the grade: the
  // issue is skipped like one with a linked PR, and no pick is recorded.
  const claimed = workClaimVetFields(getStateManager().getState().workClaims ?? [], options.issueUrl);
  if (claimed) {
    return { ...output, ...claimed, reasonsToSkip: [...output.reasonsToSkip, ...claimed.reasonsToSkip] };
  }

  const pick = await pickFor(output);
  return { ...output, ...(await persistPickSnapshots(getStateManager(), pick ? [pick] : [])) };
}

const BANNED_REASON = 'repo policy: the project does not accept AI-assisted contributions';
/** Linked docs are cut to this many characters before the parsers read them. */
const LINKED_DOC_MAX_CHARS = 100_000;

export type ScoutCandidate = Awaited<ReturnType<Awaited<ReturnType<typeof createAutopilotScout>>['vetIssue']>>;

/**
 * Scout's vetting result as vet and vet-list print it: without
 * `contributionGuidelines.rawContent` (#2046). That field is the target repo's
 * whole CONTRIBUTING file, written by the repo and unfenced. Vet reads it only
 * through {@link vetPolicy}; the output keeps scout's parsed fields and the
 * derived `policy`. Returns a copy; never mutates.
 */
export function publicVettingResult(result: ScoutCandidate['vettingResult']): ScoutCandidate['vettingResult'] {
  if (result.contributionGuidelines?.rawContent === undefined) return result;
  const guidelines = { ...result.contributionGuidelines };
  delete guidelines.rawContent;
  return { ...result, contributionGuidelines: guidelines };
}

/**
 * The repo's contribution policy as far as vet read it (#1953): scout's
 * CONTRIBUTING text and `extraDocs` through the policy parsers, plus scout's own
 * anti-LLM scan (which also reads README and CODE_OF_CONDUCT). Null when vet
 * read nothing or the scan result is missing.
 */
export function vetPolicy(candidate: ScoutCandidate, extraDocs: readonly PolicyDoc[] = []): RepoPolicy | null {
  const guidelines = candidate.vettingResult.contributionGuidelines;
  const scan = candidate.antiLLMPolicy as ScoutCandidate['antiLLMPolicy'] | undefined;
  // Without scout's README / CODE_OF_CONDUCT scan the AI reading is partial: record nothing.
  if (!scan) return null;
  const contributing = guidelines?.rawContent ? [{ file: 'CONTRIBUTING.md', content: guidelines.rawContent }] : [];
  const docs = [...contributing, ...extraDocs];
  if (docs.length === 0 && !scan.matched) return null;
  const policy = derivePolicy(docs);
  if (guidelines?.claRequired) policy.cla = 'required';
  if (!scan.matched || policy.aiPolicy === 'banned') return policy;
  const line = { file: scan.sourceFile ?? 'repo docs', quotedLine: quote(scan.matchedKeywords.join(', ')) };
  return { ...policy, aiPolicy: 'banned', source: [line, ...policy.source].slice(0, 10) };
}

type Octokit = ReturnType<typeof getOctokit>;

/** A doc's text: '' when it does not exist, null when the read failed. */
async function docText(octokit: Octokit, owner: string, repo: string, path: string): Promise<string | null> {
  let text: string | null;
  try {
    text = await probePath(octokit, owner, repo, path);
  } catch {
    return null;
  }
  return text ?? '';
}

/** The README's text: '' when there is none, null when the read failed. */
async function readmeText(octokit: Octokit, owner: string, repo: string): Promise<string | null> {
  let response: Awaited<ReturnType<Octokit['repos']['getReadme']>>;
  try {
    response = await octokit.repos.getReadme({ owner, repo });
  } catch (error) {
    return getHttpStatusCode(error) === 404 ? '' : null;
  }
  return decodeBase64(response.data.content);
}

interface ExtraDocs {
  docs: PolicyDoc[];
  /** False when any read failed: the docs are a partial view. */
  complete: boolean;
}

/** The PR template and the README-linked docs. A failed read leaves its doc out and marks the set incomplete. */
async function readExtraDocs(repoSlug: string): Promise<ExtraDocs> {
  const { owner, repo } = splitRepo(repoSlug);
  const octokit = getOctokit(requireGitHubToken());
  const [template, readme] = await Promise.all([
    fetchPRTemplate(octokit, owner, repo),
    readmeText(octokit, owner, repo),
  ]);
  const linked = await Promise.all(
    linkedPolicyDocs(readme ?? '', repoSlug).map(async (file) => ({
      file,
      content: await docText(octokit, owner, repo, file),
    })),
  );
  const templateDoc =
    template.template && template.source ? [{ file: template.source, content: template.template }] : [];
  const docs = [...templateDoc, ...linked]
    .filter((d): d is PolicyDoc => d.content !== null)
    .map((d) => ({ file: d.file, content: d.content.slice(0, LINKED_DOC_MAX_CHARS) }));
  const isComplete = template.error === undefined && readme !== null && linked.every((d) => d.content !== null);
  return { docs, complete: isComplete };
}

/**
 * Docs beyond scout's CONTRIBUTING: the PR template and up to two
 * contribution-guide docs the README links to in the same repo. At most 7 REST
 * reads (README, up to 4 template paths, 2 linked docs). Best effort: a failed
 * read leaves docs out and never fails the vet.
 */
async function extraPolicyDocs(repoSlug: string): Promise<ExtraDocs> {
  try {
    return await readExtraDocs(repoSlug);
  } catch (error) {
    warn('vet', `Could not read the PR template and linked docs of ${repoSlug}: ${errorMessage(error)}`);
    return { docs: [], complete: false };
  }
}

/**
 * Record what vet read, then report the policy that applies. A reading from an
 * incomplete set of docs only fills a gap (or records a ban), like vet-list's.
 */
async function recordedPolicyFields(candidate: ScoutCandidate): Promise<Partial<VetOutput>> {
  const repo = candidate.issue.repo;
  const extra = await extraPolicyDocs(repo);
  const derived = vetPolicy(candidate, extra.docs);
  if (derived) await recordVetPolicies([{ repo, policy: derived }], { fillOnly: !extra.complete });
  // Show what was kept: a partial reading does not override a stored record unless it is a ban.
  const isKept = extra.complete || derived?.aiPolicy === 'banned' || !storedPolicy(getStateManager().getState(), repo);
  return policyFields(candidate, isKept ? derived : null);
}

/** The policy that applies to the candidate's repo, with `derived` as the fresh reading; a ban makes the issue a skip. */
export function policyFields(candidate: ScoutCandidate, derived: RepoPolicy | null): Partial<VetOutput> {
  const repo = candidate.issue.repo;
  const policy = effectivePolicy(getStateManager().getState(), repo, derived ?? undefined);
  if (policy?.aiPolicy !== 'banned') return policyField(policy);
  // One ban reason: scout's when its scan matched (then ours only adds how to lift it), else ours.
  const note = banNote(policy, repo);
  let reason: string | null = BANNED_REASON + note;
  if (candidate.antiLLMPolicy?.matched) reason = note === '' ? null : `repo policy${note}`;
  const reasonsToSkip = reason === null ? candidate.reasonsToSkip : [...candidate.reasonsToSkip, reason];
  return { ...policyField(policy), recommendation: 'skip', reasonsToSkip };
}

/**
 * The pick to record for this vet. One verify GraphQL call supplies the issue
 * author, comment count and competing PRs, and applies vet-list's rule: no pick
 * for a closed, taken or own-PR issue (scout's first-linked-PR check can miss these). A failed verify never fails the vet:
 * the pick then falls back to scout's facts.
 */
async function pickFor(output: VetOutput): Promise<PickSnapshot | undefined> {
  if (output.linkedPRClassification?.startsWith('user_')) return undefined;
  const { repo, number, url } = output.issue;
  const [owner, name] = repo.split('/', 2);
  let verification: Awaited<ReturnType<typeof fetchIssueVerification>> | undefined;
  try {
    verification = await fetchIssueVerification(getOctokit(requireGitHubToken()), { repo: name, owner, number });
  } catch (error) {
    warn('vet', `Could not verify ${url} for pick traits: ${errorMessage(error)}`);
  }
  if (verification && RULED_OUT_VERDICTS.has(verification.verdict)) return undefined;
  return pickSnapshotFromVet(output, 'vet', {
    ...(verification && traitsFromVerification(verification)),
    firstInRepo: isFirstInRepo(repo, getStateManager().getRepoScore(repo), getStateManager().getState().mergedPRs),
  });
}

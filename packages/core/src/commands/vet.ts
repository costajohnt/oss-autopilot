/**
 * Vet command
 * Vets a specific issue before working on it via @oss-scout/core
 */

import { adaptScoutLinkedPR, buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import { type VetOutput } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';
import { gradeFromCandidate, reconcileRecommendation } from '../core/issue-grading.js';
import { repoCapField } from '../core/repo-cap.js';
import { banNote, derivePolicy, effectivePolicy, policyField, quote, type RepoPolicy } from '../core/repo-policy.js';
import { recordVetPolicy } from './policy.js';
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
    vettingResult: candidate.vettingResult,
    antiLLMPolicy: candidate.antiLLMPolicy,
    linkedPRClassification,
    ...(linkedPR && { linkedPR }),
    slmTriage: candidate.slmTriage ?? null,
    grade,
    ...repoCapField(getStateManager().getState(), candidate.issue.repo),
    // Last: a banned policy overrides the recommendation and adds a skip reason.
    ...(await policyFields(candidate)),
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

type ScoutCandidate = Awaited<ReturnType<Awaited<ReturnType<typeof createAutopilotScout>>['vetIssue']>>;

/**
 * The repo's contribution policy as far as vet read it (#1953): scout's
 * CONTRIBUTING text through the policy parsers, plus scout's own anti-LLM scan
 * (which also reads README and CODE_OF_CONDUCT). Null when vet read nothing or the
 * scan result is missing.
 */
function vetPolicy(candidate: ScoutCandidate): RepoPolicy | null {
  const guidelines = candidate.vettingResult.contributionGuidelines;
  const scan = candidate.antiLLMPolicy as ScoutCandidate['antiLLMPolicy'] | undefined;
  // Without scout's README / CODE_OF_CONDUCT scan the AI reading is partial: record nothing.
  if (!scan) return null;
  const docs = guidelines?.rawContent ? [{ file: 'CONTRIBUTING.md', content: guidelines.rawContent }] : [];
  if (docs.length === 0 && !scan.matched) return null;
  const policy = derivePolicy(docs);
  if (guidelines?.claRequired) policy.cla = 'required';
  if (!scan.matched || policy.aiPolicy === 'banned') return policy;
  const line = { file: scan.sourceFile ?? 'repo docs', quotedLine: quote(scan.matchedKeywords.join(', ')) };
  return { ...policy, aiPolicy: 'banned', source: [line, ...policy.source].slice(0, 10) };
}

/** Record what vet read, then report the policy that applies; a ban makes the issue a skip. */
async function policyFields(candidate: ScoutCandidate): Promise<Partial<VetOutput>> {
  const repo = candidate.issue.repo;
  const derived = vetPolicy(candidate);
  if (derived) await recordVetPolicy(repo, derived);
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

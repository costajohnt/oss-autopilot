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
  getStateManager,
  getOctokit,
  classifyLinkedPR,
  pickSnapshotFromVet,
  persistPickSnapshots,
  fetchIssueVerification,
  traitsFromVerification,
  isFirstInRepo,
  requireGitHubToken,
  errorMessage,
  warn,
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
    projectHealth: candidate.projectHealth,
    vettingResult: candidate.vettingResult,
    antiLLMPolicy: candidate.antiLLMPolicy,
    linkedPRClassification,
    ...(linkedPR && { linkedPR }),
    slmTriage: candidate.slmTriage ?? null,
    grade,
    ...repoCapField(getStateManager().getState(), candidate.issue.repo),
  };

  const pick = await pickFor(output);
  return { ...output, ...(await persistPickSnapshots(getStateManager(), pick ? [pick] : [])) };
}

/**
 * The pick to record for this vet. One verify GraphQL call supplies the issue
 * author, comment count and competing PRs, and catches an own open PR that
 * scout's first-linked-PR check missed. A failed verify never fails the vet:
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
  if (verification?.verdict === 'own-open-pr') return undefined;
  return pickSnapshotFromVet(output, 'vet', {
    ...(verification && traitsFromVerification(verification)),
    firstInRepo: isFirstInRepo(repo, getStateManager().getRepoScore(repo), getStateManager().getState().mergedPRs),
  });
}

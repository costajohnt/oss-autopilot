/**
 * Vet command
 * Vets a specific issue before working on it via @oss-scout/core
 */

import { adaptScoutLinkedPR, buildCandidateLinkedPR, createAutopilotScout } from './scout-bridge.js';
import { type VetOutput } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';
import { gradeFromCandidate, reconcileRecommendation } from '../core/issue-grading.js';
import { getStateManager, classifyLinkedPR } from '../core/index.js';
import { maybeCheckpoint } from '../core/state.js';
import type { PickSnapshot } from '../core/types.js';

const MODULE = 'vet';

export { type VetOutput } from '../formatters/json.js';

/**
 * The vet-time prediction to keep for calibration (#1824): joined onto the
 * outcome ledger when a PR closing this issue later merges or closes.
 */
export function pickSnapshotFromVet(vet: VetOutput, source: PickSnapshot['source']): PickSnapshot {
  const stars = (vet.projectHealth as { stargazersCount?: unknown } | null | undefined)?.stargazersCount;
  return {
    issueUrl: vet.issue.url,
    grade: vet.grade.score,
    recommendation: vet.recommendation,
    ...(typeof stars === 'number' && { stargazersCount: stars }),
    source,
    capturedAt: new Date().toISOString(),
  };
}

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
  };

  // Persist the prediction; in Gist mode only a checkpoint gets it past the
  // local cache (#1629). Best-effort: a failed push never fails the vet.
  getStateManager().recordPickSnapshots([pickSnapshotFromVet(output, 'vet')]);
  await maybeCheckpoint(getStateManager(), MODULE);
  return output;
}

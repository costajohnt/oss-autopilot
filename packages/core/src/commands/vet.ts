/**
 * Vet command
 * Vets a specific issue before working on it
 */

import { IssueDiscovery, requireGitHubToken } from '../core/index.js';
import { type VetOutput } from '../formatters/json.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

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

  const token = requireGitHubToken();

  const discovery = new IssueDiscovery(token);

  const candidate = await discovery.vetIssue(options.issueUrl);

  return {
    issue: {
      repo: candidate.issue.repo,
      number: candidate.issue.number,
      title: candidate.issue.title,
      url: candidate.issue.url,
      labels: candidate.issue.labels,
    },
    recommendation: candidate.recommendation,
    reasonsToApprove: candidate.reasonsToApprove,
    reasonsToSkip: candidate.reasonsToSkip,
    projectHealth: candidate.projectHealth,
    vettingResult: candidate.vettingResult,
  };
}

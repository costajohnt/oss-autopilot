/**
 * verify-issue command (#1353, #1354).
 *
 * Deterministic availability check for one GitHub issue: state/stateReason,
 * assignees, and linked PRs classified as `closing` vs `cross-referenced`,
 * with the authenticated user's own PRs flagged. One GraphQL round-trip,
 * no scoring, no scout heuristics — this is the ground truth the
 * issue-scout agent consumes BEFORE any judgment-based vetting.
 */

import {
  fetchIssueVerification,
  getOctokit,
  parseGitHubUrl,
  requireGitHubToken,
  type IssueVerification,
} from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { ISSUE_URL_PATTERN, validateGitHubUrl, validateUrl } from './validation.js';

export interface VerifyIssueOptions {
  issueUrl: string;
}

/**
 * Verify a GitHub issue's real availability.
 *
 * @throws {ValidationError} If the URL is not a valid GitHub issue URL or
 *   the issue does not exist.
 */
export async function runVerifyIssue(options: VerifyIssueOptions): Promise<IssueVerification> {
  validateUrl(options.issueUrl);
  validateGitHubUrl(options.issueUrl, ISSUE_URL_PATTERN, 'issue');

  const parsed = parseGitHubUrl(options.issueUrl);
  if (!parsed || parsed.type !== 'issues') {
    throw new ValidationError(`Not a parseable GitHub issue URL: ${options.issueUrl}`);
  }

  const octokit = getOctokit(requireGitHubToken());
  return fetchIssueVerification(octokit, {
    owner: parsed.owner,
    repo: parsed.repo,
    number: parsed.number,
  });
}

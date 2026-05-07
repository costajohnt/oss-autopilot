/**
 * compliance-score command (#1245).
 *
 * Fetches PR metadata via the GitHub API, runs the typed
 * `computeComplianceScore` core function, and returns the structured
 * result. Used by the `pr-compliance-checker` agent (and the
 * `compliance-score` MCP tool) to replace per-prompt scoring tables
 * with a deterministic, testable evaluation.
 *
 * Same architectural shape as `track`: read-only API call, no state
 * mutation, runs against a public PR URL.
 */

import { getOctokit, requireGitHubToken } from '../core/index.js';
import { ValidationError } from '../core/errors.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';
import { parseGitHubUrl } from '../core/urls.js';
import { computeComplianceScore, type RepoContext, type PRMetadata } from '../core/compliance-score.js';
import type { ComplianceScoreOutput } from '../formatters/json.js';

/**
 * Detect whether the target repo has visible test infrastructure. Looks
 * for the well-known directories at the repo root in a single contents
 * call. Failures (missing repo, rate limit, network) surface as
 * `undefined` so the score function falls back to its strict default.
 */
async function detectTestInfrastructure(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
): Promise<boolean | undefined> {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: '' });
    if (!Array.isArray(data)) return undefined;
    const TEST_DIR = /^(?:tests?|__tests__|spec)$/i;
    return data.some((entry) => entry.type === 'dir' && TEST_DIR.test(entry.name));
  } catch {
    return undefined;
  }
}

/**
 * Run the compliance evaluation against a PR URL.
 *
 * @throws {ValidationError} If the URL is not a valid GitHub PR URL.
 */
export async function runComplianceScore(options: { prUrl: string }): Promise<ComplianceScoreOutput> {
  validateUrl(options.prUrl);
  validateGitHubUrl(options.prUrl, PR_URL_PATTERN, 'PR');

  const token = requireGitHubToken();
  const octokit = getOctokit(token);

  const parsed = parseGitHubUrl(options.prUrl);
  if (!parsed || parsed.type !== 'pull') {
    throw new ValidationError(`Invalid PR URL: ${options.prUrl}`);
  }
  const { owner, repo, number } = parsed;

  // Fetch the PR + its files in parallel; the file list drives the
  // tests check and the focused-changes check.
  const [{ data: pr }, filesResponse, hasTestInfrastructure] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: number }),
    octokit.pulls.listFiles({ owner, repo, pull_number: number, per_page: 100 }),
    detectTestInfrastructure(octokit, owner, repo),
  ]);

  const meta: PRMetadata = {
    title: pr.title,
    body: pr.body ?? '',
    branch: pr.head.ref,
    filesChangedCount: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    files: filesResponse.data.map((f) => f.filename),
  };
  const repoContext: RepoContext = {
    hasTestInfrastructure,
  };

  const result = computeComplianceScore(meta, repoContext);

  return {
    pr: {
      repo: `${owner}/${repo}`,
      number,
      title: pr.title,
      url: options.prUrl,
    },
    score: result.score,
    rating: result.rating,
    emoji: result.emoji,
    checks: result.checks,
  };
}

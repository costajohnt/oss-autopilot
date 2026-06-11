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
import { ValidationError, errorMessage, isRateLimitOrAuthError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { validateUrl, PR_URL_PATTERN, validateGitHubUrl } from './validation.js';
import { parseGitHubUrl } from '../core/urls.js';
import {
  computeComplianceScore,
  type RepoContext,
  type PRMetadata,
  type LinkedIssueInfo,
} from '../core/compliance-score.js';
import type { ComplianceScoreOutput } from '../formatters/json.js';

const MODULE = 'compliance-score';

/**
 * Detect whether the target repo has visible test infrastructure. Looks
 * for the well-known directories at the repo root in a single contents
 * call. Non-fatal failures (missing repo, 5xx, network) surface as
 * `undefined` so the score function falls back to its strict default,
 * with a warning so "couldn't look" is distinguishable from "no test
 * dir" in logs. Rate-limit / auth errors propagate — swallowing them
 * here would mask a systemic problem affecting the whole run (#1373).
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
  } catch (err) {
    if (isRateLimitOrAuthError(err)) throw err;
    warn(MODULE, `test-infrastructure probe for ${owner}/${repo} failed: ${errorMessage(err)}`);
    return undefined;
  }
}

/**
 * Parse every issue/PR reference out of the PR body into a flat list of
 * `{ owner, repo, number }` triples (#1246 Improvement B). Handles the
 * three forms that PR bodies use in practice:
 *   - Bare same-repo: `#42` (with closing keyword or referencing keyword)
 *   - Cross-repo shorthand: `owner/repo#42`
 *   - Direct URL: `https://github.com/owner/repo/issues/42`
 *
 * Deduplicates by `(owner, repo, number)` so a body that mentions the
 * same issue twice (`Closes #42 — see #42`) results in one API call.
 */
function parseLinkedIssueReferences(
  body: string,
  defaultOwner: string,
  defaultRepo: string,
): Array<{ owner: string; repo: string; number: number }> {
  const out = new Map<string, { owner: string; repo: string; number: number }>();
  const push = (owner: string, repo: string, number: number) => {
    const key = `${owner}/${repo}#${number}`;
    if (!out.has(key)) out.set(key, { owner, repo, number });
  };

  // Bare `#42` only counts when accompanied by a closing or referencing
  // verb — random hashtags shouldn't trigger an API call.
  const BARE_REF = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|relates?\s+to|refs?|references?|see)\s+#(\d+)/gi;
  for (const match of body.matchAll(BARE_REF)) {
    push(defaultOwner, defaultRepo, Number.parseInt(match[1], 10));
  }

  const CROSS_REPO = /\b([\w.-]+)\/([\w.-]+)#(\d+)/g;
  for (const match of body.matchAll(CROSS_REPO)) {
    push(match[1], match[2], Number.parseInt(match[3], 10));
  }

  const ISSUE_OR_PR_URL = /https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/(?:issues|pull)\/(\d+)/gi;
  for (const match of body.matchAll(ISSUE_OR_PR_URL)) {
    push(match[1], match[2], Number.parseInt(match[3], 10));
  }

  return [...out.values()];
}

/**
 * Fetch each linked issue/PR via the Issues API and classify its
 * state (#1246 Improvement B). Failures (404 / rate limit / network)
 * map to `state: 'not_found'` for that single reference rather than
 * aborting the score — the function falls back to surfacing what it
 * could verify.
 */
async function verifyLinkedIssues(
  octokit: ReturnType<typeof getOctokit>,
  prRepo: { owner: string; repo: string },
  refs: Array<{ owner: string; repo: string; number: number }>,
  now: Date = new Date(),
): Promise<LinkedIssueInfo[]> {
  return Promise.all(
    refs.map(async ({ owner, repo, number }) => {
      const crossRepo = owner !== prRepo.owner || repo !== prRepo.repo;
      const fullRepo = `${owner}/${repo}`;
      try {
        const { data } = await octokit.issues.get({ owner, repo, issue_number: number });
        if (data.state === 'open') {
          return { number, repo: fullRepo, crossRepo, state: 'open' as const };
        }
        const closedAt = data.closed_at ? new Date(data.closed_at) : null;
        const closedDaysAgo = closedAt ? Math.floor((now.getTime() - closedAt.getTime()) / 86400000) : undefined;
        return { number, repo: fullRepo, crossRepo, state: 'closed' as const, closedDaysAgo };
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 404) {
          return { number, repo: fullRepo, crossRepo, state: 'not_found' as const };
        }
        // Rate limit, 5xx, network — distinct from "not found" so the
        // score function treats it neutrally. Mapping a 429 on a valid
        // open issue to `not_found` would falsely fail the
        // issue-reference check on a perfectly good PR.
        return { number, repo: fullRepo, crossRepo, state: 'unverifiable' as const };
      }
    }),
  );
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

  // Verify every linked issue/PR reference in the body (#1246 B) so
  // `Closes #999` against a non-existent or stale issue fails loud
  // instead of passing on the regex match.
  const issueRefs = parseLinkedIssueReferences(meta.body, owner, repo);
  const linkedIssues = issueRefs.length > 0 ? await verifyLinkedIssues(octokit, { owner, repo }, issueRefs) : undefined;

  const repoContext: RepoContext = {
    hasTestInfrastructure,
    linkedIssues,
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

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';

/** GitHub username: alphanumeric or hyphens (not leading/trailing/consecutive), 1-39 chars. */
const GITHUB_USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

interface BadgeResponse {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

function errorBadge(message: string): BadgeResponse {
  return { schemaVersion: 1, label: 'OSS Contributions', message, color: 'lightgrey' };
}

function pickColor(mergeRate: number): string {
  if (mergeRate >= 0.8) return 'brightgreen';
  if (mergeRate >= 0.6) return 'green';
  if (mergeRate >= 0.4) return 'yellow';
  return 'orange';
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

  if (typeof username !== 'string' || !GITHUB_USERNAME_RE.test(username)) {
    return res.status(200).json(errorBadge('invalid username'));
  }

  try {
    if (!process.env.GITHUB_TOKEN) {
      console.warn('[badge] GITHUB_TOKEN not set — using unauthenticated GitHub API (10 req/min limit)');
    }
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN || undefined,
    });

    const [mergedResult, closedResult, openResult] = await Promise.all([
      octokit.search.issuesAndPullRequests({ q: `is:pr is:merged author:${username}`, per_page: 1 }),
      octokit.search.issuesAndPullRequests({ q: `is:pr is:closed is:unmerged author:${username}`, per_page: 1 }),
      octokit.search.issuesAndPullRequests({ q: `is:pr is:open author:${username}`, per_page: 1 }),
    ]);

    const mergedCount = mergedResult.data.total_count;
    const closedCount = closedResult.data.total_count;
    const openCount = openResult.data.total_count;

    const total = mergedCount + closedCount;
    const mergeRate = total > 0 ? mergedCount / total : 0;
    const mergeRatePct = `${(mergeRate * 100).toFixed(0)}%`;

    let message: string;
    let color: string;

    if (mergedCount === 0 && openCount === 0) {
      message = 'Getting Started';
      color = 'blue';
    } else {
      message = `${mergeRatePct} merge rate | ${mergedCount} merged | ${openCount} open`;
      color = pickColor(mergeRate);
    }

    return res.status(200).json({
      schemaVersion: 1,
      label: 'OSS Contributions',
      message,
      color,
    } satisfies BadgeResponse);
  } catch (error: unknown) {
    const status = error instanceof Object && 'status' in error ? (error as { status: number }).status : undefined;
    if (status === 422) {
      return res.status(200).json(errorBadge('user not found'));
    }
    if (status === 403 || status === 429) {
      console.warn('[badge] GitHub API rate limited for', username);
      return res.status(200).json(errorBadge('rate limited'));
    }
    console.error('[badge]', error instanceof Error ? error.message : String(error));
    return res.status(200).json(errorBadge('error'));
  }
}

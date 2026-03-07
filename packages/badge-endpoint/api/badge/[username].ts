import type { VercelRequest, VercelResponse } from '@vercel/node';
import { Octokit } from '@octokit/rest';

interface BadgeResponse {
  schemaVersion: number;
  label: string;
  message: string;
  color: string;
}

function errorBadge(message: string): BadgeResponse {
  return { schemaVersion: 1, label: 'OSS Contributions', message, color: 'lightgrey' };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { username } = req.query;

  if (typeof username !== 'string' || !/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(username)) {
    return res.status(200).json(errorBadge('invalid username'));
  }

  try {
    const octokit = new Octokit();

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
      color = mergeRate >= 0.8 ? 'brightgreen' : mergeRate >= 0.6 ? 'green' : mergeRate >= 0.4 ? 'yellow' : 'orange';
    }

    return res.status(200).json({
      schemaVersion: 1,
      label: 'OSS Contributions',
      message,
      color,
    } satisfies BadgeResponse);
  } catch (error: any) {
    if (error.status === 422) {
      return res.status(200).json(errorBadge('user not found'));
    }
    return res.status(200).json(errorBadge('error'));
  }
}

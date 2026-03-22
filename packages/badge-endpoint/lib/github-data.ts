import { Octokit } from '@octokit/rest';

const USERNAME_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

export function isValidUsername(username: string): boolean {
  return USERNAME_RE.test(username);
}

export interface RecentPR {
  number: number;
  title: string;
  url: string;
  repo: string; // "owner/repo"
  mergedAt: string; // ISO timestamp
}

export interface ContributionData {
  merged: number;
  open: number;
  closedUnmerged: number;
  mergeRate: number; // 0-100
  repoCount: number;
  recentPRs: RecentPR[];
  cappedMerged: boolean;
  cappedClosedUnmerged: boolean;
  /** Daily activity: map of "YYYY-MM-DD" → count of merged PRs */
  dailyActivity: Record<string, number>;
  /** Consecutive calendar weeks (Mon-Sun, UTC) with at least one merged PR */
  streak: number;
  error?: undefined;
}

export interface ContributionError {
  error: 'user_not_found' | 'rate_limited' | 'api_error';
  merged?: undefined;
}

export type ContributionResult = ContributionData | ContributionError;

function twelveMonthsAgo(): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function extractRepo(repositoryUrl: string): string {
  return repositoryUrl.replace('https://api.github.com/repos/', '');
}

export function computeStreak(dailyActivity: Record<string, number>): number {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const currentMonday = new Date(now);
  currentMonday.setUTCDate(now.getUTCDate() - mondayOffset);
  currentMonday.setUTCHours(0, 0, 0, 0);

  let streak = 0;
  const weekStart = new Date(currentMonday);

  for (let w = 0; w < 52; w++) {
    let hasActivity = false;
    for (let d = 0; d < 7; d++) {
      const checkDate = new Date(weekStart);
      checkDate.setUTCDate(weekStart.getUTCDate() + d);
      const key = checkDate.toISOString().slice(0, 10);
      if (dailyActivity[key] && dailyActivity[key] > 0) {
        hasActivity = true;
        break;
      }
    }
    if (hasActivity) {
      streak++;
    } else if (w === 0) {
      // Current week has no activity yet — still count prior weeks
    } else {
      break;
    }
    weekStart.setUTCDate(weekStart.getUTCDate() - 7);
  }

  return streak;
}

async function paginateSearch(
  octokit: InstanceType<typeof Octokit>,
  query: string,
  maxItems: number = 1000,
): Promise<{ totalCount: number; items: any[] }> {
  const perPage = 100;
  const firstPage = await octokit.rest.search.issuesAndPullRequests({
    q: query,
    sort: 'updated',
    order: 'desc',
    per_page: perPage,
    page: 1,
  });

  const totalCount = firstPage.data.total_count;
  const items = [...firstPage.data.items];

  // GitHub caps search results at 1000; if we're at or above that, don't paginate
  if (totalCount >= maxItems) {
    return { totalCount, items };
  }

  const totalPages = Math.min(Math.ceil(totalCount / perPage), 10);

  for (let page = 2; page <= totalPages; page++) {
    const res = await octokit.rest.search.issuesAndPullRequests({
      q: query,
      sort: 'updated',
      order: 'desc',
      per_page: perPage,
      page,
    });
    items.push(...res.data.items);
  }

  return { totalCount, items };
}

export async function fetchContributionData(username: string, token: string): Promise<ContributionResult> {
  const octokit = new Octokit({ auth: token });
  const since = twelveMonthsAgo();

  try {
    // Run merged pagination first (may make multiple requests), then open/closed concurrently
    const mergedResult = await paginateSearch(octokit, `is:pr author:${username} is:merged merged:>=${since}`);

    const [openRes, closedRes] = await Promise.all([
      octokit.rest.search.issuesAndPullRequests({
        q: `is:pr author:${username} is:open`,
        sort: 'updated',
        order: 'desc',
        per_page: 1,
      }),
      octokit.rest.search.issuesAndPullRequests({
        q: `is:pr author:${username} is:unmerged is:closed closed:>=${since}`,
        sort: 'updated',
        order: 'desc',
        per_page: 1,
      }),
    ]);

    const merged = mergedResult.totalCount;
    const open = openRes.data.total_count;
    const closedUnmerged = closedRes.data.total_count;
    const mergeTotal = merged + closedUnmerged;
    const mergeRate = mergeTotal > 0 ? (merged / mergeTotal) * 100 : 0;

    const repos = new Set<string>();
    const dailyActivity: Record<string, number> = {};
    const recentPRs: RecentPR[] = [];

    for (const item of mergedResult.items) {
      const repo = extractRepo(item.repository_url);
      repos.add(repo);

      const mergedAt = (item.pull_request as any)?.merged_at ?? item.closed_at ?? '';
      if (mergedAt) {
        const day = mergedAt.slice(0, 10);
        dailyActivity[day] = (dailyActivity[day] ?? 0) + 1;
      }

      if (recentPRs.length < 5) {
        recentPRs.push({
          number: item.number,
          title: item.title,
          url: item.html_url,
          repo,
          mergedAt,
        });
      }
    }

    return {
      merged,
      open,
      closedUnmerged,
      mergeRate,
      repoCount: repos.size,
      recentPRs,
      cappedMerged: merged >= 1000,
      cappedClosedUnmerged: closedUnmerged >= 1000,
      dailyActivity,
      streak: computeStreak(dailyActivity),
    };
  } catch (err: any) {
    if (err?.status === 422) {
      return { error: 'user_not_found' };
    }
    if (err?.status === 403 || err?.status === 429) {
      console.warn('[widget] Rate limited for', username);
      return { error: 'rate_limited' };
    }
    console.error('[widget] API error for', username, err instanceof Error ? err.message : String(err));
    return { error: 'api_error' };
  }
}

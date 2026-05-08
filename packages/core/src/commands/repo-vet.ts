/**
 * repo-vet command (#1271, follow-up to #1242).
 *
 * Fetches repo health signals via the GitHub API, runs the typed
 * `computeRepoVet` core function, and returns the structured result.
 * Used by the `repo-evaluator` agent (and the future `repo-vet` MCP tool)
 * to replace per-prompt rubric assembly with a deterministic, testable
 * evaluation.
 *
 * Same architectural shape as `compliance-score`: read-only API calls,
 * no state mutation, runs against a public `owner/repo` slug.
 */

import { getOctokit, requireGitHubToken } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { validateRepoIdentifier } from './validation.js';
import { computeRepoVet, type RepoVetInput, type RepoVetResult } from '../core/repo-vet.js';
import type { RepoVetOutput } from '../formatters/json.js';

const MODULE = 'repo-vet';

const DAY_MS = 86400000;
const COMMUNITY_HEALTH_PATHS = [
  // Each entry can live at the repo root OR under .github/. We probe both
  // because some repos prefer the visible-at-root convention and some
  // prefer the .github/ folder convention.
  { key: 'hasContributing', candidates: ['CONTRIBUTING.md', '.github/CONTRIBUTING.md'] },
  { key: 'hasIssueTemplates', candidates: ['.github/ISSUE_TEMPLATE'] },
  {
    key: 'hasPRTemplate',
    candidates: ['.github/pull_request_template.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md'],
  },
  { key: 'hasCodeOfConduct', candidates: ['CODE_OF_CONDUCT.md', '.github/CODE_OF_CONDUCT.md'] },
] as const;

/**
 * Returns true when the path exists. Treats 404 as "absent" (the only
 * shape we care about for community-health flags). Re-throws everything
 * else — auth/rate-limit failures must not silently scrub the
 * `hasContributing` etc. flags to `false`, which would understate a
 * repo's community health on a token that lacks scope or has been
 * throttled mid-sequence.
 */
async function probePath(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
  path: string,
): Promise<boolean> {
  try {
    await octokit.repos.getContent({ owner, repo, path });
    return true;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return false;
    throw err;
  }
}

/**
 * Probe each community-health path. Treats 404 as "absent" (a definitive
 * signal). On any other error (auth, rate-limit, 5xx) the per-key result
 * stays `false` AND the whole-function `incomplete` flag is set so the
 * caller knows community-health was unverified rather than confirmed-absent.
 *
 * This is the per-key analogue of the call-level catch: instead of either
 * silently misclassifying 403 → absent OR aborting the entire repo-vet
 * call, we degrade gracefully and surface the gap.
 */
async function checkCommunityHealth(
  octokit: ReturnType<typeof getOctokit>,
  owner: string,
  repo: string,
): Promise<{
  hasContributing: boolean;
  hasIssueTemplates: boolean;
  hasPRTemplate: boolean;
  hasCodeOfConduct: boolean;
  incomplete: boolean;
}> {
  const out: Record<string, boolean> = {
    hasContributing: false,
    hasIssueTemplates: false,
    hasPRTemplate: false,
    hasCodeOfConduct: false,
  };
  let incomplete = false;
  await Promise.all(
    COMMUNITY_HEALTH_PATHS.map(async ({ key, candidates }) => {
      let sawError = false;
      for (const path of candidates) {
        try {
          if (await probePath(octokit, owner, repo, path)) {
            out[key] = true;
            return;
          }
        } catch (err) {
          // probePath only throws on non-404 errors. Don't abandon
          // remaining candidates — `CONTRIBUTING.md` failing with 403
          // does NOT imply `.github/CONTRIBUTING.md` will fail too. Mark
          // the per-key probe as incomplete only if every candidate
          // either errored or returned absent.
          warn(MODULE, `community-health probe for ${owner}/${repo}/${path} failed: ${errorMessage(err)}`);
          sawError = true;
          continue;
        }
      }
      // Reached only when no candidate hit. If any candidate errored,
      // the absent flag is unreliable — surface that to the caller so
      // the agent prompt distinguishes "probed all candidates and
      // absent" from "couldn't tell".
      if (sawError) incomplete = true;
    }),
  );
  return {
    hasContributing: out.hasContributing,
    hasIssueTemplates: out.hasIssueTemplates,
    hasPRTemplate: out.hasPRTemplate,
    hasCodeOfConduct: out.hasCodeOfConduct,
    incomplete,
  };
}

interface ClosedPR {
  created_at: string;
  merged_at: string | null;
  updated_at: string;
}

function summarizePRMerges(
  prs: ClosedPR[],
  windowDays: number,
  now: Date,
): { prMergeTimesDays: number[]; mergedCount: number; openedCount: number } {
  const cutoff = now.getTime() - windowDays * DAY_MS;
  const prMergeTimesDays: number[] = [];
  let mergedCount = 0;
  let openedCount = 0;

  for (const pr of prs) {
    const createdAt = new Date(pr.created_at).getTime();
    if (createdAt >= cutoff) openedCount += 1;

    if (pr.merged_at) {
      const mergedAt = new Date(pr.merged_at).getTime();
      if (mergedAt >= cutoff) {
        mergedCount += 1;
        const days = (mergedAt - createdAt) / DAY_MS;
        if (Number.isFinite(days) && days >= 0) prMergeTimesDays.push(days);
      }
    }
  }
  return { prMergeTimesDays, mergedCount, openedCount };
}

interface CommitEntry {
  commit: { author?: { date?: string } | null };
  author?: { login?: string } | null;
}

function summarizeCommits(
  commits: CommitEntry[],
  now: Date,
): { commitsLast30Days: number; contributorsLast90d: number; lastCommitISO: string | null } {
  const cutoff30 = now.getTime() - 30 * DAY_MS;
  const cutoff90 = now.getTime() - 90 * DAY_MS;
  const contributors90 = new Set<string>();
  let commitsLast30Days = 0;
  let lastCommitMs: number | null = null;

  for (const c of commits) {
    const dateStr = c.commit.author?.date;
    if (!dateStr) continue;
    const ts = new Date(dateStr).getTime();
    if (Number.isNaN(ts)) continue;

    if (lastCommitMs === null || ts > lastCommitMs) lastCommitMs = ts;
    if (ts >= cutoff30) commitsLast30Days += 1;
    if (ts >= cutoff90 && c.author?.login) contributors90.add(c.author.login);
  }

  return {
    commitsLast30Days,
    contributorsLast90d: contributors90.size,
    lastCommitISO: lastCommitMs ? new Date(lastCommitMs).toISOString() : null,
  };
}

/**
 * Run the repo-vet evaluation against an `owner/repo` slug.
 *
 * @throws {ValidationError} If the repo identifier is malformed.
 */
export async function runRepoVet(options: { repo: string }): Promise<RepoVetOutput> {
  validateRepoIdentifier(options.repo);
  const [owner, repo] = options.repo.split('/');

  const token = requireGitHubToken();
  const octokit = getOctokit(token);
  const now = new Date();

  const [repoMetaResp, closedPRsResp, commitsResp, releasesResp, communityHealthSummary] = await Promise.all([
    octokit.repos.get({ owner, repo }),
    octokit.pulls.list({ owner, repo, state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 }),
    octokit.repos.listCommits({ owner, repo, per_page: 100 }),
    octokit.repos
      .listReleases({ owner, repo, per_page: 1 })
      .catch(() => ({ data: [] as Array<{ published_at: string | null; created_at: string }> })),
    checkCommunityHealth(octokit, owner, repo),
  ]);

  const prs: ClosedPR[] = closedPRsResp.data.map((p) => ({
    created_at: p.created_at,
    merged_at: p.merged_at,
    updated_at: p.updated_at,
  }));
  const { prMergeTimesDays, mergedCount, openedCount } = summarizePRMerges(prs, 90, now);
  const commitSummary = summarizeCommits(commitsResp.data as CommitEntry[], now);

  const releases = releasesResp.data;
  const lastReleaseISO = releases.length > 0 ? (releases[0].published_at ?? releases[0].created_at ?? null) : null;

  const input: RepoVetInput = {
    stars: repoMetaResp.data.stargazers_count ?? 0,
    forks: repoMetaResp.data.forks_count ?? 0,
    openIssues: repoMetaResp.data.open_issues_count ?? 0,
    watchers: repoMetaResp.data.subscribers_count ?? 0,
    isArchived: repoMetaResp.data.archived ?? false,
    lastPushed: repoMetaResp.data.pushed_at ?? new Date(0).toISOString(),
    createdAt: repoMetaResp.data.created_at ?? new Date(0).toISOString(),
    commitsLast30Days: commitSummary.commitsLast30Days,
    prMergeTimesDays,
    mergedCount90Days: mergedCount,
    openedCount90Days: openedCount,
    lastCommitISO: commitSummary.lastCommitISO,
    contributorsLast90d: commitSummary.contributorsLast90d,
    lastReleaseISO,
    hasContributing: communityHealthSummary.hasContributing,
    hasIssueTemplates: communityHealthSummary.hasIssueTemplates,
    hasPRTemplate: communityHealthSummary.hasPRTemplate,
    hasCodeOfConduct: communityHealthSummary.hasCodeOfConduct,
  };

  const result: RepoVetResult = computeRepoVet(input);

  // The core function names its metadata object `repo`. Rename to `repoMeta`
  // at the CLI boundary so the top-level slug doesn't collide with it.
  // Also overlay the community-health `incomplete` flag the wrapper
  // tracks (the core type doesn't carry it because computeRepoVet is
  // pure — only the wrapper makes the API calls that can fail mid-probe).
  const { repo: repoMeta, communityHealth, ...rest } = result;
  return {
    repoSlug: options.repo,
    fetchedAt: now.toISOString(),
    repoMeta,
    communityHealth: { ...communityHealth, incomplete: communityHealthSummary.incomplete },
    ...rest,
  };
}

/**
 * Per-repo open-PR cap. First PRs into a repo merge less often than later
 * ones, so discovery stops surfacing a repo once the user has
 * `maxOpenPRsPerRepo` open PRs there, or `maxOpenPRsColdRepo` while none of
 * their PRs in it have merged yet. 0 disables either cap.
 *
 * Open-PR counts come from the last digest (`state.lastDigest.openPRs`), the
 * same source scout's open-PR phase reads, so they are as fresh as the last
 * `daily` run.
 */

import type { AgentState } from './state-schema.js';
import { parseGitHubUrl } from './urls.js';

export interface RepoCapStatus {
  repo: string;
  openPRCount: number;
  mergedPRCount: number;
  /** True while the user has no merged PR in this repo, so the cold cap applies. */
  cold: boolean;
  /** The cap that applies (0 = no cap). */
  cap: number;
  atCap: boolean;
  /** The repo is in `config.excludeRepos`. */
  excluded: boolean;
  /** Human-readable reason, set when `atCap` or `excluded`. */
  reason?: string;
}

/** Open-PR counts from the last digest, keyed by lowercased owner/repo. */
export function openPRCountsByRepo(state: Readonly<AgentState>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pr of state.lastDigest?.openPRs ?? []) {
    const key = pr.repo.toLowerCase();
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function mergedCount(state: Readonly<AgentState>, repo: string): number {
  const key = repo.toLowerCase();
  const scoreEntry = Object.entries(state.repoScores ?? {}).find(([r]) => r.toLowerCase() === key)?.[1];
  const fromScore = scoreEntry?.mergedPRCount ?? 0;
  if (fromScore > 0) return fromScore;
  // Fall back to the outcome ledger: repoScores can lag behind it.
  return (state.mergedPRs ?? []).filter((pr) => {
    const parsed = parseGitHubUrl(pr.url);
    return parsed !== null && `${parsed.owner}/${parsed.repo}`.toLowerCase() === key;
  }).length;
}

/**
 * Cap status for one repo. Pass `openCounts` from {@link openPRCountsByRepo}
 * when checking many repos so the digest is scanned once.
 */
export function getRepoCapStatus(
  state: Readonly<AgentState>,
  repo: string,
  openCounts: Map<string, number> = openPRCountsByRepo(state),
): RepoCapStatus {
  // ponytail: tolerate partial states (test fixtures, hand-built mocks); a
  // parsed AgentState always has these defaults.
  const { maxOpenPRsPerRepo = 0, maxOpenPRsColdRepo = 0, excludeRepos = [] } = state.config ?? {};
  const openPRCount = openCounts.get(repo.toLowerCase()) ?? 0;
  const mergedPRCount = mergedCount(state, repo);
  const cold = mergedPRCount === 0;
  // The cold cap only tightens: it never raises a lower warm cap.
  const caps = [maxOpenPRsPerRepo, cold ? maxOpenPRsColdRepo : 0].filter((c) => c > 0);
  const cap = caps.length > 0 ? Math.min(...caps) : 0;
  const atCap = cap > 0 && openPRCount >= cap;
  const excluded = excludeRepos.some((r) => r.toLowerCase() === repo.toLowerCase());

  const reasons: string[] = [];
  if (excluded) reasons.push(`${repo} is in excludeRepos`);
  if (atCap) {
    reasons.push(
      `${repo} has ${openPRCount} open PR(s), at the cap of ${cap}` +
        (cold ? ' for a repo where none of your PRs have merged yet' : ''),
    );
  }
  return {
    repo,
    openPRCount,
    mergedPRCount,
    cold,
    cap,
    atCap,
    excluded,
    ...(reasons.length > 0 && { reason: reasons.join('; ') }),
  };
}

/** `{ repoCap }` when the repo is at cap or excluded, else `{}`; spread into vet output. */
export function repoCapField(state: Readonly<AgentState>, repo: string): { repoCap?: RepoCapStatus } {
  const status = getRepoCapStatus(state, repo);
  return status.reason ? { repoCap: status } : {};
}

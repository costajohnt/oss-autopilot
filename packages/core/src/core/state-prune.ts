/**
 * Keeps the persisted AgentState small (the Gist API truncates file content
 * at 1 MB). Pruning runs on a copy at serialization time, so the in-memory
 * state a running command works with is never touched.
 */
import type { AgentState } from './state-schema.js';
import { parseGitHubUrl } from './urls.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Rotation TTL autopilot passes to oss-scout's search (pinned, not scout's default). */
export const SCOUT_ROTATION_TTL_DAYS = 7;

/**
 * searchSeen's only reader is scout's rotation, which ignores entries older
 * than {@link SCOUT_ROTATION_TTL_DAYS}. One day of margin covers clock skew.
 */
export const SEARCH_SEEN_RETENTION_DAYS = SCOUT_ROTATION_TTL_DAYS + 1;

/**
 * A repo score with no merge/close history and no tracked PR or issue is only
 * scout's cached observation; scout re-creates it the next time it sees the repo.
 */
export const REPO_SCORE_RETENTION_DAYS = 14;

/** Repos the user has any tracked work in. Their scores are never pruned. */
function trackedRepos(state: AgentState): Set<string> {
  const digest = state.lastDigest;
  const direct = [...(digest?.openPRs ?? []), ...(digest?.shelvedPRs ?? []), ...state.activeIssues].map((x) => x.repo);
  const urls = [
    ...(state.mergedPRs ?? []).map((pr) => pr.url),
    ...(state.closedPRs ?? []).map((pr) => pr.url),
    ...(state.config.shelvedPRUrls ?? []),
  ];
  const fromUrls = urls.flatMap((url) => {
    const parsed = parseGitHubUrl(url);
    return parsed ? [`${parsed.owner}/${parsed.repo}`] : [];
  });
  const repos = new Set(direct);
  for (const repo of fromUrls) repos.add(repo);
  return repos;
}

/** Returns a pruned shallow copy of `state`; the input is not mutated. */
export function pruneStateForPersist(state: AgentState, now: number = Date.now()): AgentState {
  const seenCutoff = now - SEARCH_SEEN_RETENTION_DAYS * DAY_MS;
  const searchSeen = state.searchSeen.filter((e) => Date.parse(e.lastSeenAt) >= seenCutoff);

  const scoreCutoff = now - REPO_SCORE_RETENTION_DAYS * DAY_MS;
  const keep = trackedRepos(state);
  const repoScores = Object.fromEntries(
    Object.entries(state.repoScores).filter(([repo, s]) => {
      const hasHistory = s.mergedPRCount > 0 || s.closedWithoutMergeCount > 0;
      const evaluatedAt = Date.parse(s.lastEvaluatedAt);
      const isFresh = Number.isNaN(evaluatedAt) || evaluatedAt >= scoreCutoff; // unparseable: keep
      return hasHistory || keep.has(repo) || isFresh;
    }),
  );

  // The status partitions are filters of openPRs (PRMonitor.generateDigest),
  // so persist each PR once; DailyDigestSchema re-derives them on load.
  // Written as [] (not omitted) so older clients still parse the state.
  const lastDigest = state.lastDigest && {
    ...state.lastDigest,
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
  };

  return { ...state, searchSeen, repoScores, lastDigest };
}

/** Compact JSON of the pruned state, for every state write (Gist, cache, local file). */
export function serializeState(state: AgentState): string {
  return JSON.stringify(pruneStateForPersist(state));
}

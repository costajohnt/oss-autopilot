/**
 * Contribution strategy compute (#1243).
 *
 * Extracts the deterministic compute layer from
 * `agents/contribution-strategist.md` so the categorization,
 * trajectory detection, and capacity overextension rules are typed,
 * unit-testable, and consumable both by the agent (synthesis layer)
 * and a future auto-display in `/oss`.
 *
 * Same architectural shape as success-grade (#858), linked-PR
 * classifier (#910), and compliance-score (#1245). Pure function — no
 * I/O, no global state, no LLM. The interpretive narrative ("you're
 * doing X well, here's a growth opportunity") stays in the agent
 * prompt.
 */

import type { AgentState } from './state-schema.js';

export type ContributorStyle = 'maintainer' | 'explorer' | 'specialist' | 'generalist';
export type TrajectoryDirection = 'growing' | 'steady' | 'declining';
export type CapacityAction = 'open_more' | 'follow_up_dormant' | 'wait_on_maintainers' | null;

export interface StrategyProfile {
  style: ContributorStyle;
  totalPRs: number;
  mergedCount: number;
  /** Merge rate as a 0-1 fraction. `0` when no PRs are tracked. */
  mergeRate: number;
  /** Top languages by repo PR count, descending. Empty when language data
   * is not available in repoScores. */
  primaryLanguages: string[];
  /** Top repos by merged PR count, descending. */
  favoriteRepos: string[];
}

export interface StrategyCapacity {
  openPRCount: number;
  dormantPRCount: number;
  /** Distinct repos hosting at least one dormant PR. Surfaces alongside
   * `dormantPRCount` so consumers can render "N PRs across M repos"
   * without re-deriving from `openPRs` themselves. */
  dormantRepoCount: number;
  /** True when dormant PRs span >=2 distinct repos (a signal that the
   * contributor is awaiting reviews from multiple maintainers, not just
   * one slow project). Equivalent to `dormantPRCount >= 2 &&
   * dormantRepoCount >= 2` — exposed as a separate boolean so callers
   * with a strict yes/no presentation don't have to recompute. */
  overExtended: boolean;
  /** The single highest-priority next action — null when state is too
   * thin to recommend anything. */
  suggestedAction: CapacityAction;
}

export interface StrategyPatterns {
  prTypeDistribution: {
    docs: number;
    fixes: number;
    features: number;
    refactors: number;
    tests: number;
    other: number;
  };
  trajectoryDirection: TrajectoryDirection;
  averagePRSize: number;
}

export interface StrategyRecommendations {
  languages: string[];
  repos: string[];
  issueTypes: string[];
  avoidPatterns: string[];
}

export interface StrategyResult {
  profile: StrategyProfile;
  capacity: StrategyCapacity;
  patterns: StrategyPatterns;
  recommendations: StrategyRecommendations;
}

/** Minimum tracked PR history before strategy output is meaningful (#1243). */
export const STRATEGY_MIN_PRS = 10;

/** How many top-N items each "primary" / "favorite" list returns. */
const TOP_N = 5;

/** Days since `mergedAt` after which a PR no longer counts as recent for
 * the active-now PR-type distribution. 90 days matches the issue's
 * proposed trajectory window. */
const RECENT_WINDOW_DAYS = 90;

/** Match repo from a GitHub URL: `https://github.com/owner/repo/pull/N`. */
const REPO_FROM_URL = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/i;

function parseRepo(url: string): string | null {
  const m = url.match(REPO_FROM_URL);
  return m ? `${m[1]}/${m[2]}` : null;
}

function classifyTitle(title: string): keyof StrategyPatterns['prTypeDistribution'] {
  const t = title.trim().toLowerCase();
  // Match Conventional Commits prefix first; fall back to keyword search
  // in the title body.
  const prefix = t.match(/^(feat|fix|docs|refactor|test|perf|chore|build|ci|style|revert)(?:\([^)]+\))?!?:/);
  const tag = prefix?.[1];
  if (tag === 'docs') return 'docs';
  if (tag === 'fix' || tag === 'perf') return 'fixes';
  if (tag === 'feat') return 'features';
  if (tag === 'refactor') return 'refactors';
  if (tag === 'test') return 'tests';
  // Heuristic fallbacks for non-conventional titles.
  if (/\b(?:doc|readme|comment|typo)\b/i.test(t)) return 'docs';
  if (/\b(?:fix|bug|crash|regression|broken)\b/i.test(t)) return 'fixes';
  if (/\b(?:add|implement|introduce|support|new)\b/i.test(t)) return 'features';
  if (/\b(?:refactor|cleanup|extract|simplify|rename)\b/i.test(t)) return 'refactors';
  if (/\btest|spec\b/i.test(t)) return 'tests';
  return 'other';
}

function topNByCount(counts: Record<string, number>, n: number): string[] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([name]) => name);
}

function determineStyle(_totalPRs: number, primaryLanguages: string[], favoriteRepos: string[]): ContributorStyle {
  // `totalPRs` is reserved for future "explorer" classification (low-volume
  // contributors). Today the function is only reachable from `computeStrategy`
  // which gates at `merged.length >= STRATEGY_MIN_PRS` (10), so a `totalPRs < 5`
  // branch could never fire — removed to avoid misleading future readers.
  // Heavy concentration in 1-2 repos → maintainer; spread across many → generalist.
  if (favoriteRepos.length === 1) return 'maintainer';
  if (primaryLanguages.length === 1 && favoriteRepos.length >= 2 && favoriteRepos.length <= 3) {
    return 'specialist';
  }
  if (favoriteRepos.length >= 4) return 'generalist';
  return 'specialist';
}

function determineTrajectory(state: AgentState): TrajectoryDirection {
  // Compare the last three months' merged PR counts against the prior
  // three months. If each window has at least one merge, ratio >1.2 is
  // growing, <0.8 is declining, otherwise steady.
  const counts = state.monthlyMergedCounts ?? {};
  const months = Object.keys(counts).sort();
  if (months.length < 6) return 'steady';
  const recent = months.slice(-3).reduce((sum, m) => sum + (counts[m] ?? 0), 0);
  const prior = months.slice(-6, -3).reduce((sum, m) => sum + (counts[m] ?? 0), 0);
  if (prior === 0) return recent > 0 ? 'growing' : 'steady';
  const ratio = recent / prior;
  if (ratio >= 1.2) return 'growing';
  if (ratio <= 0.8) return 'declining';
  return 'steady';
}

function recommendForOverExtension(openPRCount: number, dormantPRCount: number, overExtended: boolean): CapacityAction {
  if (overExtended) return 'follow_up_dormant';
  if (dormantPRCount > 0 && openPRCount > 5) return 'wait_on_maintainers';
  if (openPRCount === 0) return 'open_more';
  return null;
}

/**
 * Read-only mirror of the status-override lookup (#1416): same staleness
 * rule as `StateManager.getStatusOverride` (an override recorded against
 * older activity than the PR's `updatedAt` is ignored), but with NO
 * auto-clear write — this module stays pure/no-I/O, and the daily and
 * dashboard pipelines own clearing stale overrides.
 */
function effectiveStatus(pr: { url?: unknown; status?: unknown; updatedAt?: unknown }, state: AgentState): unknown {
  if (typeof pr.url !== 'string') return pr.status;
  const override = state.config.statusOverrides?.[pr.url];
  if (!override) return pr.status;
  if (typeof pr.updatedAt === 'string' && pr.updatedAt > override.lastActivityAt) return pr.status;
  if (override.status !== 'needs_addressing' && override.status !== 'waiting_on_maintainer') return pr.status;
  return override.status;
}

/**
 * Compute the deterministic strategy signal from agent state. Returns
 * null when state is thinner than {@link STRATEGY_MIN_PRS} merged PRs —
 * the auto-display surface uses this null sentinel as the
 * minimum-data gate (#1243).
 */
export function computeStrategy(state: AgentState): StrategyResult | null {
  const merged = state.mergedPRs ?? [];
  const closed = state.closedPRs ?? [];
  const totalPRs = merged.length + closed.length;
  if (merged.length < STRATEGY_MIN_PRS) return null;

  // Per-repo PR counts (merged). Used both for "favorite repos" and to
  // back-fill primary languages from `repoScores` entries that overlap.
  const mergedByRepo: Record<string, number> = {};
  for (const pr of merged) {
    const repo = parseRepo(pr.url);
    if (!repo) continue;
    mergedByRepo[repo] = (mergedByRepo[repo] ?? 0) + 1;
  }
  const favoriteRepos = topNByCount(mergedByRepo, TOP_N);

  // Languages: weight a repo's language by that repo's merged count so
  // `vercel/next.js` (TypeScript) counts more than a one-off PR to a
  // Lua project even if both repos are in `repoScores`.
  const languageCounts: Record<string, number> = {};
  for (const [repo, count] of Object.entries(mergedByRepo)) {
    const score = state.repoScores[repo];
    const lang = score?.language;
    if (!lang) continue;
    languageCounts[lang] = (languageCounts[lang] ?? 0) + count;
  }
  const primaryLanguages = topNByCount(languageCounts, TOP_N);

  // PR-type distribution over the recent window.
  const distribution: StrategyPatterns['prTypeDistribution'] = {
    docs: 0,
    fixes: 0,
    features: 0,
    refactors: 0,
    tests: 0,
    other: 0,
  };
  const cutoff = Date.now() - RECENT_WINDOW_DAYS * 86400000;
  for (const pr of merged) {
    const mergedAt = Date.parse(pr.mergedAt);
    if (Number.isNaN(mergedAt) || mergedAt < cutoff) continue;
    distribution[classifyTitle(pr.title)] += 1;
  }

  // Capacity: read from the last digest. When no digest exists yet,
  // default to zero (the agent has nothing to recommend without a
  // digest). The DailyDigest schema does not store a `dormantCount`
  // directly — derive it from the "awaiting maintainer review" bucket.
  //
  // Status-basis reconciliation (#1416): dashboard-written digests keep RAW
  // statuses in `openPRs` (so override CLEARS stay visible on rebuild) while
  // `summary.totalActivePRs` is override-basis. Re-derive the waiting bucket
  // from `openPRs` through the override map so both capacity inputs share
  // one basis; fall back to the stored array for digests without `openPRs`
  // (which daily.ts builds post-override anyway).
  const summary = state.lastDigest?.summary;
  const openPRCount = summary?.totalActivePRs ?? 0;
  const openPRs = (state.lastDigest?.openPRs ?? []) as Array<{ url?: unknown; status?: unknown; updatedAt?: unknown }>;
  const waiting =
    openPRs.length > 0
      ? openPRs.filter((pr) => effectiveStatus(pr, state) === 'waiting_on_maintainer')
      : (state.lastDigest?.waitingOnMaintainerPRs ?? []);
  const dormantPRCount = waiting.length;
  // Overextended: dormant PRs spread across 2+ repos. Same definition
  // the issue body uses.
  const dormantRepos = new Set(
    waiting
      .map((pr) => (typeof (pr as { url?: unknown }).url === 'string' ? parseRepo((pr as { url: string }).url) : null))
      .filter((r): r is string => r !== null),
  );
  const overExtended = dormantPRCount >= 2 && dormantRepos.size >= 2;

  const profile: StrategyProfile = {
    style: determineStyle(totalPRs, primaryLanguages, favoriteRepos),
    totalPRs,
    mergedCount: merged.length,
    mergeRate: totalPRs === 0 ? 0 : merged.length / totalPRs,
    primaryLanguages,
    favoriteRepos,
  };

  const capacity: StrategyCapacity = {
    openPRCount,
    dormantPRCount,
    dormantRepoCount: dormantRepos.size,
    overExtended,
    suggestedAction: recommendForOverExtension(openPRCount, dormantPRCount, overExtended),
  };

  const patterns: StrategyPatterns = {
    prTypeDistribution: distribution,
    trajectoryDirection: determineTrajectory(state),
    // Without per-PR diff size in StoredMergedPR, a true "average PR
    // size" lookup is out of scope until that data is captured (#1243
    // explicitly defers this). Surface 0 so downstream callers know the
    // signal is unavailable rather than fabricating a value.
    averagePRSize: 0,
  };

  const recommendations: StrategyRecommendations = {
    // The deterministic recommendations layer reuses the profile
    // signals — the agent's coaching prose layers on top of these.
    languages: primaryLanguages,
    repos: favoriteRepos,
    issueTypes: deriveIssueTypePreferences(distribution),
    avoidPatterns: deriveAvoidPatterns(capacity, patterns),
  };

  return { profile, capacity, patterns, recommendations };
}

/** Cadence trigger thresholds for the auto-display in `/oss` (#1270). */
export const STRATEGY_CADENCE_DAYS = 30;
export const STRATEGY_CADENCE_MERGED_DELTA = 5;

/**
 * Decide whether a strategy snapshot should be embedded in this daily run.
 * Returns true when EITHER 30 days have elapsed since the last snapshot OR
 * 5+ PRs have merged since then, AND the merge floor in
 * {@link STRATEGY_MIN_PRS} is met. The caller is responsible for calling
 * {@link computeStrategy} when this returns true and for persisting
 * `state.lastStrategyAt` after a successful compute.
 *
 * `nowIso` is injected so tests can pin time without mocking `Date`.
 */
export function shouldComputeStrategy(state: AgentState, nowIso: string): boolean {
  const merged = state.mergedPRs ?? [];
  if (merged.length < STRATEGY_MIN_PRS) return false;

  const lastIso = state.lastStrategyAt;
  if (!lastIso) return true;

  // Time-based trigger: 30+ days since last snapshot.
  const lastMs = Date.parse(lastIso);
  const nowMs = Date.parse(nowIso);
  if (Number.isFinite(lastMs) && Number.isFinite(nowMs)) {
    const daysSince = (nowMs - lastMs) / (1000 * 60 * 60 * 24);
    if (daysSince >= STRATEGY_CADENCE_DAYS) return true;
  } else {
    // Unparseable timestamps — fail open and recompute rather than
    // silently never re-firing. The lastStrategyAt write below will
    // refresh to a valid ISO string.
    return true;
  }

  // Merge-count trigger: count PRs merged after `lastStrategyAt`.
  // `mergedAt` is required on StoredMergedPRSchema; `Date.parse` returns
  // NaN for malformed-but-stored data and Number.isFinite excludes those.
  const mergedSince = merged.filter((pr) => {
    const mergedMs = Date.parse(pr.mergedAt);
    return Number.isFinite(mergedMs) && mergedMs > lastMs;
  }).length;
  return mergedSince >= STRATEGY_CADENCE_MERGED_DELTA;
}

function deriveIssueTypePreferences(distribution: StrategyPatterns['prTypeDistribution']): string[] {
  // Recommend the user's two strongest PR types — they have a track
  // record there, so issues in those buckets are higher-yield.
  const ranked = Object.entries(distribution)
    .filter(([type]) => type !== 'other')
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([type]) => type);
  return ranked;
}

function deriveAvoidPatterns(capacity: StrategyCapacity, patterns: StrategyPatterns): string[] {
  const out: string[] = [];
  if (capacity.overExtended) {
    out.push('opening new PRs while dormant ones await review across multiple repos');
  }
  if (patterns.trajectoryDirection === 'declining') {
    out.push('drifting away from a previously productive cadence — capacity may be saturated');
  }
  return out;
}

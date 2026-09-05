/**
 * Search command
 * Searches for new issues to work on via @oss-scout/core
 */

import {
  adaptScoutLinkedPR,
  buildCandidateLinkedPR,
  createAutopilotScout,
  SEARCH_DIVERSITY_RATIO,
  type ScoutBridgeDiagnostics,
} from './scout-bridge.js';
import { SearchStrategySchema, type SearchStrategy } from '@oss-scout/core';
import { classifyLinkedPR, getStateManager, maybeCheckpoint } from '../core/index.js';
import { type SearchOutput } from '../formatters/json.js';
import { gradeFromCandidate } from '../core/issue-grading.js';
import { computeStrategy } from '../core/strategy.js';
import { refreshStarredReposIfStale } from '../core/starred-repos.js';
import { debug, warn } from '../core/logger.js';

export { type SearchOutput } from '../formatters/json.js';

const MODULE = 'search';

/**
 * Hard cap on issue-search result count. Shared between CLI (`cli-registry.ts`),
 * MCP tool (`tools.ts`), and MCP prompt (`prompts.ts`) so a future adjustment
 * lands in one place instead of three (#1002).
 */
export const MAX_SEARCH_RESULTS = 100;

/**
 * Default issue-search result count when no count is passed (#1571). Sized to
 * leave headroom past scout's affinity phases (merged-PR + starred), which can
 * fill a small cap on their own and starve the broad/maintained phases via the
 * `allCandidates.length < maxResults` gate. Shared between CLI
 * (`cli-registry.ts`), MCP tool (`tools.ts`), and MCP prompt (`prompts.ts`).
 */
export const DEFAULT_SEARCH_RESULTS = 15;

/**
 * Diversity-counterweight ratio (#1244). Moved to `scout-bridge.ts` in #1464
 * (it is now also baked into the bridge-built `ScoutPreferences`); re-exported
 * here so existing importers keep working.
 */
export { SEARCH_DIVERSITY_RATIO } from './scout-bridge.js';

interface SearchOptions {
  maxResults: number;
  /**
   * Restrict discovery to specific scout phases (#1244 selector surface).
   * Undefined runs scout's default staged pipeline (all phases). Passed
   * straight through to `scout.search`, which gates each phase on the set.
   */
  strategies?: SearchStrategy[];
}

/**
 * Parse and validate a comma-separated `--strategy` value into scout strategies.
 *
 * Mirrors oss-scout's own CLI validation so an unknown token fails fast with a
 * clear message instead of silently running all phases. Returns `undefined`
 * for an absent/empty value so scout falls back to its default (all phases).
 *
 * @throws {Error} If any token is not a valid scout strategy.
 */
export function parseSearchStrategies(raw: string | undefined): SearchStrategy[] | undefined {
  if (raw === undefined) return undefined;
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (tokens.length === 0) return undefined;
  const strategies: SearchStrategy[] = [];
  for (const token of tokens) {
    const parsed = SearchStrategySchema.safeParse(token);
    if (!parsed.success) {
      throw new Error(
        `Unknown search strategy "${token}". Valid strategies: merged, orgs, starred, broad, maintained, all`,
      );
    }
    strategies.push(parsed.data);
  }
  return strategies;
}

/**
 * Search GitHub for contributable issues using multi-phase discovery.
 *
 * @param options - Search configuration
 * @param options.maxResults - Maximum number of candidates to return
 * @returns Search results with scored candidates and exclusion lists
 * @throws {ConfigurationError} If no GitHub token is available
 *
 * @example
 * ```typescript
 * import { runSearch } from '@oss-autopilot/core/commands';
 *
 * const results = await runSearch({ maxResults: 10 });
 * for (const c of results.candidates) {
 *   console.log(`${c.issue.repo}#${c.issue.number} — ${c.viabilityScore}/100`);
 * }
 * ```
 */
/**
 * Coerce scout's raw `viabilityScore` into a trustworthy 0–100 number.
 * Scout is supposed to emit a finite integer in range, but out-of-contract
 * values (NaN, Infinity, negative, >100, non-number) would otherwise flow
 * straight through to consumers. Defend at the boundary — see #1043.
 */
function sanitizeViabilityScore(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100) {
    warn(MODULE, `Ignoring out-of-contract viabilityScore from scout: ${JSON.stringify(raw)}`);
    return 0;
  }
  return raw;
}

/**
 * Read a non-negative integer scout-delay override from an env var.
 *
 * Scout spaces its multi-phase `/search/issues` calls with an inter-phase
 * delay (default 30s) and a broad-phase delay (default 90s) to stay under
 * GitHub's secondary rate limit (see `buildScoutState`). Those delays make a
 * single `search` invocation take ~100s, which is fine in normal use but makes
 * the live-API e2e suite (`search.e2e.test.ts`, run only in the nightly
 * workflow — see #1452) impractically slow. These env vars let that suite
 * collapse the delays so the test completes in a realistic CI window.
 *
 * Returns `undefined` when the var is unset/empty or not a parseable
 * non-negative integer, so scout falls back to its preference value and
 * production behavior is unchanged. Only the live test/nightly run sets them.
 */
function readScoutDelayOverride(envVar: string): number | undefined {
  const raw = process.env[envVar];
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    warn(MODULE, `Ignoring invalid ${envVar}="${raw}" (expected a non-negative integer); using scout's default delay`);
    return undefined;
  }
  return parsed;
}

/**
 * Retention window for the search seen-set (#1528). Entries older than this are
 * culled so the list stays bounded. Set well beyond oss-scout's rotation TTL
 * (default 7 days) so an entry scout would still exclude is never dropped early.
 */
export const SEARCH_SEEN_RETENTION_DAYS = 30;

/**
 * Record the issues surfaced by a search into the durable seen-set (#1528) so
 * the next search rotates past them, and cull entries older than
 * {@link SEARCH_SEEN_RETENTION_DAYS}. Re-surfacing an issue refreshes its
 * timestamp. No-op-safe: an empty `surfacedUrls` still culls stale entries.
 */
export function recordSearchSeen(stateManager: ReturnType<typeof getStateManager>, surfacedUrls: string[]): void {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const cutoff = now - SEARCH_SEEN_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const byUrl = new Map(stateManager.getSearchSeen().map((e) => [e.url, e]));
  for (const url of surfacedUrls) {
    byUrl.set(url, { url, lastSeenAt: nowIso });
  }

  const next = [...byUrl.values()].filter((e) => {
    const seen = Date.parse(e.lastSeenAt);
    return Number.isNaN(seen) ? false : seen >= cutoff;
  });
  stateManager.setSearchSeen(next);
}

export async function runSearch(options: SearchOptions): Promise<SearchOutput> {
  // Collect bridge-level degradation signals (#1448): an unreadable skip file
  // means scout searched with an empty skip list, so explicitly-skipped
  // issues may resurface — the envelope must say so, not just stderr.
  const bridgeDiagnostics: ScoutBridgeDiagnostics = {};
  const stateManager = getStateManager();

  // Populate the starred-repo cache before the scout is created. Scout's
  // discovery runs a starred-repo search phase, but it only fires when
  // config.starredRepos is non-empty, and createAutopilotScout snapshots that
  // config into the ScoutState. Without this refresh the starred phase is a
  // silent no-op and discovery recycles the merged-PR repos every run. Fails
  // soft, so a GitHub hiccup never blocks the search.
  await refreshStarredReposIfStale(stateManager);

  const scout = await createAutopilotScout(bridgeDiagnostics);

  // Derive personalization from local history (#1244). `computeStrategy`
  // returns null below the merged-PR floor — in that case we pass nothing
  // and scout falls back to the bridge-built preferences, which derive the
  // same values from the same state (#1464), so the sort is identical either
  // way. The explicit per-call pass is kept for self-documentation. Once
  // strategy data is available, scout boosts language/repo matches into a
  // separate sort tier (still no filtering). avoidRepos/boostIssueTypes are
  // not passed per-call: scout reads them from the bridge-built preferences.
  const strategy = computeStrategy(stateManager.getState());
  const preferLanguages = strategy?.recommendations.languages ?? undefined;
  const preferRepos = strategy?.recommendations.repos ?? undefined;
  if (preferLanguages?.length || preferRepos?.length) {
    debug(
      MODULE,
      `Applying strategy bias to search: preferLanguages=${JSON.stringify(preferLanguages ?? [])}, preferRepos=${JSON.stringify(preferRepos ?? [])}`,
    );
  }

  // Live-API test/nightly affordance (#1452): collapse scout's inter-phase
  // delays so the e2e suite finishes in a realistic window. Unset in normal
  // use → undefined → scout falls back to the 30s/90s preference defaults.
  const interPhaseDelayMs = readScoutDelayOverride('OSS_AUTOPILOT_SCOUT_INTER_PHASE_DELAY_MS');
  const broadPhaseDelayMs = readScoutDelayOverride('OSS_AUTOPILOT_SCOUT_BROAD_PHASE_DELAY_MS');

  const result = await scout.search({
    maxResults: options.maxResults,
    ...(options.strategies ? { strategies: options.strategies } : {}),
    preferLanguages,
    preferRepos,
    diversityRatio: SEARCH_DIVERSITY_RATIO,
    ...(interPhaseDelayMs !== undefined ? { interPhaseDelayMs } : {}),
    ...(broadPhaseDelayMs !== undefined ? { broadPhaseDelayMs } : {}),
  });

  // Record everything scout surfaced this round into the durable seen-set so
  // the next search rotates past it (#1528). Done before the own-PR filter so
  // hidden-but-surfaced issues also rotate out. Persists to AgentState.
  recordSearchSeen(
    stateManager,
    result.candidates.map((c) => c.issue.url),
  );
  // In Gist mode setSearchSeen only writes the local cache; without a
  // checkpoint the seen-set never reaches the Gist and the next startup's
  // Gist refetch overwrites the cache with the empty remote copy (#1629).
  const gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);

  // #1354: never surface issues the user already has an open PR for. Uses
  // scout's structured linked-PR metadata when present; candidates without it
  // pass through (the issue-scout agent re-checks via verify-issue anyway).
  // Empty login means "can't prove any PR is the user's own" — nothing hidden.
  const userLogin = stateManager.getState().config?.githubUsername ?? '';
  if (userLogin === '') {
    warn(MODULE, 'githubUsername not configured — the own-PR filter (#1354) cannot run; hiddenOwnPRCount will be 0');
  }
  const visibleCandidates = result.candidates.filter(
    (c) => classifyLinkedPR({ linkedPR: adaptScoutLinkedPR(c.vettingResult?.linkedPR), userLogin }) !== 'user_open',
  );
  const hiddenOwnPRCount = result.candidates.length - visibleCandidates.length;
  if (hiddenOwnPRCount > 0) {
    debug(MODULE, `Hid ${hiddenOwnPRCount} candidate(s) with the user's own open PR (#1354)`);
  }

  const searchOutput: SearchOutput = {
    candidates: visibleCandidates.map((c) => {
      const repoScoreRecord = stateManager.getRepoScore(c.issue.repo);
      // Scout's `search` does not emit per-candidate projectHealth (only
      // `vetIssue` does). Pass a sentinel `checkFailed: true` so the grader
      // correctly treats scout-side signals as unknown and grades purely from
      // the autopilot-tracked repoScore. Candidates without a repoScore
      // receive 'F' — that's an honest signal for "we haven't seen this repo
      // before" rather than a fabricated score.
      //
      // Note (#1465): repoScore here is the cached HISTORY score (the user's
      // own merge outcomes — docs/repo-scores.md §History score), so this
      // grade reflects history only; `vet` later re-grades the same issue
      // with freshly fetched repo health and can legitimately disagree.
      const grade = gradeFromCandidate({
        repo: c.issue.repo,
        projectHealth: {
          repo: c.issue.repo,
          checkFailed: true,
          failureReason: 'health not fetched on the multi-issue search surface',
        },
        getRepoScore: (repo) => {
          const score = stateManager.getRepoScore(repo);
          return score
            ? {
                mergedPRCount: score.mergedPRCount,
                closedWithoutMergeCount: score.closedWithoutMergeCount,
                avgResponseDays: score.avgResponseDays ?? null,
              }
            : undefined;
        },
      });
      const linkedPR = buildCandidateLinkedPR(c.vettingResult?.linkedPR);
      return {
        issue: {
          repo: c.issue.repo,
          repoUrl: `https://github.com/${c.issue.repo}`,
          number: c.issue.number,
          title: c.issue.title,
          url: c.issue.url,
          labels: c.issue.labels,
        },
        recommendation: c.recommendation,
        reasonsToApprove: c.reasonsToApprove,
        reasonsToSkip: c.reasonsToSkip,
        searchPriority: c.searchPriority,
        viabilityScore: sanitizeViabilityScore(c.viabilityScore),
        grade,
        repoScore: repoScoreRecord
          ? {
              score: repoScoreRecord.score,
              mergedPRCount: repoScoreRecord.mergedPRCount,
              closedWithoutMergeCount: repoScoreRecord.closedWithoutMergeCount,
              isResponsive: repoScoreRecord.signals?.isResponsive ?? false,
              lastMergedAt: repoScoreRecord.lastMergedAt,
            }
          : undefined,
        ...(linkedPR ? { linkedPR } : {}),
        // Scout 1.0 folded the boostScore/boostReasons/diversitySlot trio into a
        // single `personalization` field (#158). Derive the flat output fields
        // from it so this command's JSON shape is unchanged.
        ...(c.personalization?.kind === 'boosted' ? { boostScore: c.personalization.score } : {}),
        ...(c.personalization?.kind === 'boosted' && c.personalization.reasons.length > 0
          ? { boostReasons: c.personalization.reasons }
          : {}),
        ...(c.personalization?.kind === 'diversity' ? { diversitySlot: true } : {}),
      };
    }),
    excludedRepos: result.excludedRepos,
    aiPolicyBlocklist: result.aiPolicyBlocklist,
    hiddenOwnPRCount,
  };
  if (gistSyncWarning) {
    searchOutput.gistSyncWarning = gistSyncWarning;
  }
  if (result.rateLimitWarning) {
    searchOutput.rateLimitWarning = result.rateLimitWarning;
  }
  if (bridgeDiagnostics.skipListUnavailable) {
    searchOutput.skipListUnavailable = true;
  }
  return searchOutput;
}

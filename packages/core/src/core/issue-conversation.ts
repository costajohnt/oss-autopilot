/**
 * Issue Conversation Monitor — tracks issues the user has commented on or is
 * working on, and detects replies that need attention.
 *
 * Follows the same pattern as PRMonitor: stateless fetch from GitHub,
 * bounded concurrency via worker pool, bot/acknowledgment filtering.
 *
 * Two reply rules apply (#1862):
 * - On an issue the user only commented on in passing, a reply counts when
 *   it is directed at the user: from a maintainer (OWNER / MEMBER /
 *   COLLABORATOR), @mentions the user, or quotes the user's comment (#343).
 * - On an engaged issue (claimed, or linked from one of the user's PRs; see
 *   `collectEngagedIssues`), any substantive non-bot comment after the
 *   user's last word counts, and so does anything directed at the user even
 *   when short (a maintainer's "any update?"). Short thanks and "+1" /
 *   emoji-only reactions do not, except that a bare status request on a
 *   claimed issue is addressed to the claimant and counts. Engaged issues
 *   the comment search does not return (the user never commented, or not
 *   within the window) are looked up in batched GraphQL queries, and the
 *   ones still open and updated since the engagement have their comments
 *   read directly, up to {@link MAX_DIRECT_ENGAGED_FETCHES} per run, most
 *   recently updated first.
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import {
  isBotAuthor,
  isAcknowledgmentComment,
  isReactionOnlyComment,
  isQuoteReplyTo,
  isStatusNudge,
} from './comment-utils.js';
import { paginateAll, paginateAllDetailed } from './pagination.js';
import { getHttpCache, cachedRequest } from './http-cache.js';
import { getStateManager } from './state.js';
import { daysBetween } from './dates.js';
import { splitRepo, extractOwnerRepo, isOwnRepo, parseGitHubUrl, issueRefKey } from './urls.js';
import { runWorkerPool, DEFAULT_CONCURRENCY } from './concurrency.js';
import type { AgentConfig, CommentedIssue, IssueConversationStatus, IssueEngagement } from './types.js';
import { toIssueEngagement, type EngagedIssue } from './engaged-issues.js';
import { lookupEngagedIssues, type EngagedIssueLookup, type EngagedIssueRef } from './engaged-issue-lookup.js';
import {
  ConfigurationError,
  ValidationError,
  errorMessage,
  getHttpStatusCode,
  isRateLimitOrAuthError,
} from './errors.js';
import { debug, warn } from './logger.js';

const MODULE = 'issue-conversation';

const MAX_CONCURRENT_REQUESTS = DEFAULT_CONCURRENCY;

/**
 * Most engaged issues whose comments are read directly per run when the
 * comment search misses them (#1862). Only issues the batched lookup found
 * open and updated since the engagement count; each costs its comment pages,
 * ETag-cached, so a quiet day is mostly 304s. The cap bounds a first run for
 * a user with many active claims. Most recently updated issues come first,
 * so an issue that gets a new comment moves to the front on the next run,
 * but one that stays quiet behind a hundred busier ones is not read until
 * the busier ones settle. That is why hitting the cap is a warning.
 */
export const MAX_DIRECT_ENGAGED_FETCHES = 100;

/** Associations that indicate someone with repo-level permissions. */
const MAINTAINER_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

/** The search-result fields the analysis reads; a direct fetch builds the same shape. */
interface IssueItem {
  html_url: string;
  number: number;
  title: string;
  labels?: Array<string | { name?: string }>;
}

interface Candidate {
  /** From the search result, or from the batched lookup for a direct fetch. */
  item: IssueItem;
  url: string;
  repoFullName: string;
  engagement?: EngagedIssue;
}

/** A direct candidate with the issue's update time, for the cap's ordering. */
interface DirectCandidate {
  candidate: Candidate;
  updatedMs: number;
}

/** The result's non-fatal channels, filled in as the run goes. */
interface RunReport {
  warnings: string[];
  failures: Array<{ issueUrl: string; error: string }>;
}

export interface FetchCommentedIssuesOptions {
  /** Window for the comment search, in days (default 30). */
  maxDays?: number;
  /** The user's engaged issues (#1862); see `collectEngagedIssues`. */
  engaged?: ReadonlyMap<string, EngagedIssue>;
}

export interface FetchCommentedIssuesResult {
  issues: CommentedIssue[];
  /**
   * Per-issue failures: the batched lookup of an engaged issue the search
   * missed (the first `lookupFailures` entries), then the comment fetches
   * and analyses that threw.
   */
  failures: Array<{ issueUrl: string; error: string }>;
  /**
   * How many of `failures` are engaged-issue lookups that failed (#1862),
   * as opposed to comment fetches. A lookup failure means an engaged issue
   * was not checked at all this run, so the dashboard names it separately.
   */
  lookupFailures: number;
  /**
   * Non-fatal problems for the run's warning channel: a claimed or open-PR
   * issue that is gone, a comment thread too long to read to the end, an
   * engagement time that does not parse, engaged issues with new activity
   * left unread because the comment-fetch cap bit. Each means the result
   * may be missing or misreporting something the user can act on.
   */
  warnings: string[];
}

interface TimelineEntry {
  author: string;
  body: string;
  createdAt: string;
  isUser: boolean;
  authorAssociation: string;
}

function parseMs(value: string | undefined): number {
  if (!value) return -Infinity;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? -Infinity : ms;
}

function excerpt(body: string): string {
  return body.slice(0, 200) + (body.length > 200 ? '...' : '');
}

function describeError(error: unknown): string {
  const status = getHttpStatusCode(error);
  return status === undefined ? errorMessage(error) : `HTTP ${status}: ${errorMessage(error)}`;
}

/**
 * Whether a gone engaged issue is worth a warning: a claim or an open PR
 * still points at it and the user can release the claim or fix the PR's
 * closing link. A finished PR's link is history; nothing to act on.
 */
function isActionableEngagement(engagement: IssueEngagement | undefined): boolean {
  return engagement?.reason === 'claim' || engagement?.reason === 'open_pr';
}

export class IssueConversationMonitor {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Whether the configured user commented on `issueUrl` at or after `since`
   * (#1863). Backs the closed-PR status nudge: once the user has told the
   * linked issue what happened, the nudge drops out. GitHub's `since` filter
   * keys on `updated_at`, so an old comment edited after the close would
   * come back too; `created_at` is re-checked to count only new comments.
   *
   * @throws {ConfigurationError} If no GitHub username is configured
   * @throws {ValidationError} If `issueUrl` is not a GitHub issue URL
   */
  async hasUserCommentSince(issueUrl: string, since: string): Promise<boolean> {
    const username = this.stateManager.getState().config.githubUsername;
    if (!username) {
      throw new ConfigurationError('No GitHub username configured. Run setup first.');
    }
    const parsed = parseGitHubUrl(issueUrl);
    if (!parsed) {
      throw new ValidationError(`Invalid issue URL format: ${issueUrl}`);
    }
    const { owner, repo, number } = parsed;
    const comments = await paginateAll((page) =>
      this.octokit.issues.listComments({ owner, repo, since, page, issue_number: number, per_page: 100 }),
    );
    const user = username.toLowerCase();
    const sinceMs = Date.parse(since);
    return comments.some((c) => c.user?.login?.toLowerCase() === user && Date.parse(c.created_at) >= sinceMs);
  }

  /**
   * Fetch issues the user has commented on or is engaged in and determine
   * conversation state. Filters out: user-authored issues, user-owned repos,
   * excluded repos/orgs, AI policy blocklisted repos, and pull requests.
   * Engaged issues (#1862) are scanned under the wider reply rule and
   * fetched directly when the comment search misses them.
   */
  async fetchCommentedIssues(options: FetchCommentedIssuesOptions = {}): Promise<FetchCommentedIssuesResult> {
    const { maxDays = 30, engaged = new Map<string, EngagedIssue>() } = options;
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      throw new ConfigurationError('No GitHub username configured. Run setup first.');
    }

    const username = config.githubUsername;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxDays);
    const since = cutoffDate.toISOString().split('T', 1)[0];
    const report: RunReport = { warnings: [], failures: [] };
    const { warnings, failures } = report;

    debug(MODULE, `Fetching commented issues for @${username} (last ${maxDays} days)...`);

    // Search for open issues the user has commented on, updated within window
    // Single page (100) is sufficient for most users; log if truncated.
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `commenter:${username} type:issue state:open updated:>=${since}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    });

    if (data.total_count > 100) {
      warn(
        MODULE,
        `Search returned ${data.total_count} results but only first 100 were fetched. Some commented issues may be missing.`,
      );
    }

    // Filter out PRs, user-authored issues, excluded repos, and blocklisted repos.
    // Also parse repo info for each candidate to avoid re-parsing in analyzeIssueConversation.
    const candidates: Candidate[] = [];
    const seenKeys = new Set<string>();
    for (const item of data.items) {
      // Defensive: skip pull requests in case type:issue qualifier is unreliable
      if (item.pull_request) continue;

      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        warn(MODULE, `Skipping issue with unparseable URL: ${item.html_url}`);
        continue;
      }
      const repoFullName = `${parsed.owner}/${parsed.repo}`;
      const key = issueRefKey(item.html_url) ?? item.html_url;
      seenKeys.add(key);

      // Skip user-authored issues
      if (item.user?.login?.toLowerCase() === username.toLowerCase()) continue;
      if (!this.isRepoAllowed(repoFullName, config)) continue;

      candidates.push({ item, repoFullName, engagement: engaged.get(key), url: item.html_url });
    }

    // Live engaged issues the search did not return are looked up directly.
    const missing: EngagedIssue[] = [];
    for (const entry of engaged.values()) {
      if (!entry.fetchWhenMissing || seenKeys.has(entry.key)) continue;
      const parsed = extractOwnerRepo(entry.url);
      if (!parsed || !this.isRepoAllowed(`${parsed.owner}/${parsed.repo}`, config)) continue;
      missing.push(entry);
    }
    candidates.push(...(await this.collectDirectCandidates(missing, username, cutoffDate, report)));
    // Lookup failures are already in `failures`; the analysis tallies below
    // count only the candidates the pool analyzed.
    const lookupFailures = failures.length;

    debug(MODULE, `Found ${candidates.length} commented issues to check`);

    // Fetch comments for each issue using worker pool.
    const results: CommentedIssue[] = [];

    await runWorkerPool(
      candidates,
      async (candidate) => {
        try {
          const issue = await this.analyzeIssueConversation(
            candidate.item,
            candidate.repoFullName,
            username,
            candidate.engagement,
            warnings,
          );
          if (issue) {
            results.push(issue);
            return;
          }
          // An engaged issue with nothing to report is not a failure.
          if (candidate.engagement) return;
          failures.push({
            issueUrl: candidate.url,
            error:
              'No user comment found despite commenter: search match (possible pagination or eventual consistency)',
          });
        } catch (error) {
          // Rate-limit / auth failures must propagate, not degrade to "fewer
          // results" — under throttling every sibling analysis fails the same
          // way and the partial result silently looks like a quiet day (#1391).
          // runWorkerPool aborts remaining workers and rejects; daily.ts and
          // dashboard-data.ts rethrow rate-limit/auth from their phase catches,
          // aborting the run just like PRMonitor's 429s do.
          if (isRateLimitOrAuthError(error)) throw error;
          const msg = describeError(error);
          failures.push({ issueUrl: candidate.url, error: msg });
          warn(MODULE, `Error analyzing issue ${candidate.url}: ${msg}`);
        }
      },
      MAX_CONCURRENT_REQUESTS,
    );

    const analysisFailures = failures.length - lookupFailures;
    if (lookupFailures > 0) {
      warn(MODULE, `${lookupFailures} engaged issue lookup(s) failed`);
    }
    if (analysisFailures > 0) {
      warn(MODULE, `${analysisFailures}/${candidates.length} issue analysis call(s) failed`);
    }
    if (analysisFailures === candidates.length && candidates.length > 0) {
      warn(
        MODULE,
        `All ${candidates.length} issue analysis call(s) failed. Possible systemic issue (network, GitHub availability).`,
      );
    }
    for (const message of warnings) warn(MODULE, message);

    // Sort: new_response first, then waiting, then acknowledged
    const statusOrder: Record<IssueConversationStatus, number> = {
      new_response: 0,
      waiting: 1,
      acknowledged: 2,
    };
    results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    debug(
      MODULE,
      `Analyzed ${results.length} issue conversations (${results.filter((i) => i.status === 'new_response').length} with new responses)`,
    );
    return { failures, lookupFailures, warnings, issues: results };
  }

  /** Repo-level exclusions shared by the search results and the direct fetches. */
  private isRepoAllowed(repoFullName: string, config: AgentConfig): boolean {
    const { owner } = splitRepo(repoFullName);
    // Skip issues in user-owned repos (we only care about contributing to others' projects)
    if (isOwnRepo(owner, config.githubUsername)) return false;
    if (config.excludeRepos.includes(repoFullName)) return false;
    if (config.excludeOrgs?.some((org) => owner.toLowerCase() === org.toLowerCase())) return false;
    const blocklist = (config.aiPolicyBlocklist || []).map((r) => r.toLowerCase());
    return !blocklist.includes(repoFullName.toLowerCase());
  }

  /**
   * Candidates for the engaged issues the comment search did not return
   * (#1862): one batched GraphQL lookup for all of them, then the issues
   * still open, not the user's own, and updated since the later of the
   * search window's start and the engagement step, most recently updated
   * first, up to {@link MAX_DIRECT_ENGAGED_FETCHES}. The window keeps this
   * path consistent with the commenter search (a reply older than `maxDays`
   * is not surfaced either way); the engagement step tightens it because
   * only comments after that step can be replies to the user. The issues
   * past the cap are named in a warning: the next run reorders by update
   * time again, so one that is commented on moves to the front, but with a
   * hundred busier issues ahead of it a quiet one can wait a long time.
   *
   * @throws The lookup's rate-limit or auth error; other lookup failures are
   *   recorded per issue in `report.failures`.
   */
  private async collectDirectCandidates(
    missing: EngagedIssue[],
    username: string,
    cutoffDate: Date,
    report: RunReport,
  ): Promise<Candidate[]> {
    const refs: EngagedIssueRef[] = [];
    for (const entry of missing) {
      const parsed = parseGitHubUrl(entry.url);
      if (parsed) refs.push({ owner: parsed.owner, repo: parsed.repo, number: parsed.number, url: entry.url });
    }
    if (refs.length === 0) return [];
    const lookups = await lookupEngagedIssues(this.octokit, refs);

    const active: DirectCandidate[] = [];
    for (const entry of missing) {
      const outcome = lookups.get(entry.url);
      if (!outcome) continue;
      const direct = this.toDirectCandidate(entry, outcome, username, cutoffDate, report);
      if (direct) active.push(direct);
    }
    active.sort((a, b) => b.updatedMs - a.updatedMs);

    const deferred = active.slice(MAX_DIRECT_ENGAGED_FETCHES);
    if (deferred.length > 0) {
      const plural = deferred.length === 1 ? '' : 's';
      report.warnings.push(
        `${deferred.length} engaged issue${plural} with new activity ${deferred.length === 1 ? 'was' : 'were'} not scanned this run (cap of ${MAX_DIRECT_ENGAGED_FETCHES} comment fetches per run, most recently updated first; replies there stay unseen until fewer issues are busier): ${deferred.map((d) => d.candidate.url).join(', ')}`,
      );
    }
    return active.slice(0, MAX_DIRECT_ENGAGED_FETCHES).map((d) => d.candidate);
  }

  /**
   * The direct candidate one lookup outcome yields, or undefined with the
   * reason logged: a lookup failure (recorded), a gone issue (a warning only
   * while a claim or an open PR still points at it), a pull request number,
   * a closed issue, one the user authored, or one untouched since the
   * engagement. The candidate's repo and number come from the node's URL,
   * not the engagement's: GitHub follows a transferred issue to its new
   * repo, and the comments live there.
   */
  private toDirectCandidate(
    entry: EngagedIssue,
    outcome: EngagedIssueLookup,
    username: string,
    cutoffDate: Date,
    report: RunReport,
  ): DirectCandidate | undefined {
    if (outcome.kind === 'failed') {
      report.failures.push({ issueUrl: entry.url, error: outcome.error });
      warn(MODULE, `Error looking up engaged issue ${entry.url}: ${outcome.error}`);
      return undefined;
    }
    if (outcome.kind === 'gone') {
      // The issue was deleted, transferred, or made private since the PR or
      // claim linked it. Worth telling the user only while something of
      // theirs still points at it (a claim to release, an open PR's closing
      // link); a finished PR's link is history.
      const message = `${entry.url}: issue no longer reachable (${outcome.reason}); dropped`;
      if (isActionableEngagement(entry)) report.warnings.push(message);
      else debug(MODULE, message);
      return undefined;
    }
    const skip = (reason: string): undefined => {
      debug(MODULE, `Skipping engaged issue ${entry.url}: ${reason}`);
    };
    if (outcome.kind === 'pull_request') return skip('the number is a pull request');

    const { node } = outcome;
    if (node.state !== 'OPEN') return skip(`issue is ${node.state.toLowerCase()}`);
    if (node.author?.login.toLowerCase() === username.toLowerCase()) return skip('authored by the user');
    const updatedMs = parseMs(node.updatedAt);
    const activitySinceMs = Math.max(cutoffDate.getTime(), parseMs(entry.since));
    if (updatedMs < activitySinceMs) return skip(`not updated since ${node.updatedAt}`);

    const parsed = extractOwnerRepo(node.url);
    if (!parsed) {
      report.warnings.push(`${entry.url}: skipped; GitHub returned it at an unparseable URL "${node.url}"`);
      return undefined;
    }
    const labelNodes = node.labels?.nodes ?? [];
    const item: IssueItem = {
      html_url: node.url,
      number: node.number,
      title: node.title,
      labels: labelNodes.filter((label) => label !== null).map((label) => label.name),
    };
    const candidate: Candidate = {
      item,
      url: node.url,
      repoFullName: `${parsed.owner}/${parsed.repo}`,
      engagement: entry,
    };
    return { candidate, updatedMs };
  }

  /**
   * Analyze a single issue's comment thread to determine conversation status.
   * Returns null when there is nothing to report: the user never commented
   * on a non-engaged issue (the search said otherwise), or an engaged issue
   * the user never commented on has no reply yet (nothing to wait for).
   */
  private async analyzeIssueConversation(
    item: IssueItem,
    repoFullName: string,
    username: string,
    engagement: EngagedIssue | undefined,
    warnings: string[],
  ): Promise<CommentedIssue | null> {
    const { timeline, truncated } = await this.fetchTimeline(item, repoFullName, username);
    if (truncated) {
      // Comments arrive oldest-first, so hitting the pagination cap drops
      // the NEWEST responses and the status below may be stale (#1456).
      // Engaged issues are the long-lived threads most likely to hit this.
      warnings.push(
        `${item.html_url}: comment thread longer than the pagination cap; the newest comments were not read and its conversation status may be stale`,
      );
    }

    // Find the user's last comment
    let userLastComment: TimelineEntry | undefined;
    for (const entry of timeline) {
      if (entry.isUser) userLastComment = entry;
    }

    if (!userLastComment && !engagement) {
      // Shouldn't happen with commenter: search, but be safe
      warn(MODULE, `No user comment found for ${item.html_url} despite commenter: search match`);
      return null;
    }

    // The user's last word on the thread: their last comment, or the later
    // of that and the engagement step (claim, PR opened) on engaged issues.
    const userLastWordMs = Math.max(parseMs(userLastComment?.createdAt), parseMs(engagement?.since));
    if (userLastWordMs === -Infinity) {
      // Engaged, no comment from the user, and nothing to anchor "after the
      // user's last word" on. A missing `since` (ledger link without an
      // opening time) is expected and cannot happen on a direct fetch; a
      // stamp that does not parse is bad state worth a warning.
      if (engagement?.since === undefined) {
        debug(MODULE, `Skipping engaged issue ${item.html_url}: no user comment and no engagement time`);
      } else {
        warnings.push(
          `${item.html_url}: skipped; the user never commented and the engagement time "${engagement.since}" does not parse`,
        );
      }
      return null;
    }

    const userMention = `@${username.toLowerCase()}`;
    const userLastCommentBody = userLastComment?.body;
    // Directed at the user (#343, extended by #1862 with quote replies):
    //   1. From a maintainer (OWNER/MEMBER/COLLABORATOR) — inherently authoritative
    //   2. @mentions the user — explicitly addressed
    //   3. Quotes the user's last comment — explicitly addressed
    // This filters out community "+1" and "me too" noise.
    const isDirectedAtUser = (entry: TimelineEntry): boolean =>
      MAINTAINER_ASSOCIATIONS.has(entry.authorAssociation) ||
      entry.body.toLowerCase().includes(userMention) ||
      (userLastCommentBody !== undefined && isQuoteReplyTo(entry.body, userLastCommentBody));
    // On an engaged issue (#1862) a comment is relevant when it is directed
    // at the user (a maintainer's "any update?" is short but still a reply),
    // when it says more than a reaction, or, on a claimed issue, when it is a
    // bare status request: "any update?" there asks the claimant. `claimed`,
    // not `reason`: an open PR outranks the claim as the reason, and the
    // claimant is still the one being asked.
    const isRelevant = (entry: TimelineEntry): boolean => {
      if (isDirectedAtUser(entry)) return true;
      if (!engagement) return false;
      if (engagement.claimed && isStatusNudge(entry.body)) return true;
      return !isReactionOnlyComment(entry.body);
    };

    // A reply: by someone else after the user's last word, substantive and relevant.
    const isAfterUser = (entry: TimelineEntry): boolean =>
      !entry.isUser && !isBotAuthor(entry.author) && parseMs(entry.createdAt) > userLastWordMs;
    const isReply = (entry: TimelineEntry): boolean =>
      isAfterUser(entry) && !isAcknowledgmentComment(entry.body) && isRelevant(entry);
    let lastResponse: TimelineEntry | undefined;
    for (const entry of timeline) {
      if (isReply(entry)) lastResponse = entry;
    }

    if (!userLastComment && !lastResponse) {
      debug(MODULE, `Engaged issue ${item.html_url} has no reply after ${engagement?.since}; nothing to report`);
      return null;
    }

    const labels = (item.labels || []).map((l) => (typeof l === 'string' ? l : l.name || '')).filter(Boolean);
    // One of the two is set: the -Infinity check above returned otherwise.
    const userLastWordAt = userLastComment?.createdAt ?? engagement?.since ?? '';

    // Body excerpts stay RAW here on purpose (#1372): these objects feed the
    // dashboard SPA and the CLI text renderers directly, and the matching
    // above (acknowledgment / @mention / quote) operates on raw text. The
    // `<github-content>` fence is applied at the agent-facing serialization
    // boundary in `toDailyOutput()` (commands/daily.ts).
    const base = {
      repo: repoFullName,
      number: item.number,
      title: item.title,
      url: item.html_url,
      userLastCommentedAt: userLastWordAt,
      userLastCommentBody: excerpt(userLastComment?.body ?? ''),
      labels,
      daysSinceUserComment: daysBetween(new Date(userLastWordMs), new Date()),
      ...(engagement && { engagement: toIssueEngagement(engagement) }),
    };

    if (lastResponse) {
      return {
        ...base,
        status: 'new_response' as const,
        lastResponseAuthor: lastResponse.author,
        lastResponseBody: excerpt(lastResponse.body),
        lastResponseAt: lastResponse.createdAt,
        isFromMaintainer: MAINTAINER_ASSOCIATIONS.has(lastResponse.authorAssociation),
      };
    }

    // No relevant response found. Determine whether the user or a relevant
    // commenter spoke last. Irrelevant community comments are excluded from
    // this check too (#343). A relevant comment the engagement step already
    // answered (posted before the claim or the PR) does not count as waiting.
    const lastRelevantComment = [...timeline].reverse().find((e) => {
      if (isBotAuthor(e.author)) return false;
      return e.isUser || isRelevant(e);
    });
    const isWaiting =
      lastRelevantComment !== undefined &&
      !lastRelevantComment.isUser &&
      parseMs(lastRelevantComment.createdAt) > userLastWordMs;
    return { ...base, status: isWaiting ? ('waiting' as const) : ('acknowledged' as const) };
  }

  /**
   * All comments on the issue, oldest first, with deleted-account comments
   * dropped. `truncated` is set when the pagination cap cut the thread short.
   */
  private async fetchTimeline(
    item: IssueItem,
    repoFullName: string,
    username: string,
  ): Promise<{ timeline: TimelineEntry[]; truncated: boolean }> {
    const { owner, repo } = splitRepo(repoFullName);

    const cache = getHttpCache();
    // Each page gets its own cache entry (URL includes `page`) so issues with
    // >100 comments still get conditional-request savings on every page, not
    // just the first.
    const { items: allComments, truncated } = await paginateAllDetailed((page) => {
      const url = `/repos/${owner}/${repo}/issues/${item.number}/comments?per_page=100&page=${page}`;
      return cachedRequest(
        cache,
        url,
        (headers) =>
          this.octokit.issues.listComments({
            owner,
            repo,
            issue_number: item.number,
            per_page: 100,
            page,
            headers,
          }) as Promise<{
            data: Awaited<ReturnType<Octokit['issues']['listComments']>>['data'];
            headers: Record<string, string>;
          }>,
      ).then((data) => ({ data }));
    });
    const timeline: TimelineEntry[] = [];
    for (const comment of allComments) {
      if (!comment.user?.login) continue; // Skip comments from deleted accounts
      const author = comment.user.login;
      timeline.push({
        author,
        body: comment.body || '',
        createdAt: comment.created_at,
        isUser: author.toLowerCase() === username.toLowerCase(),
        authorAssociation:
          typeof (comment as Record<string, unknown>).author_association === 'string'
            ? ((comment as Record<string, unknown>).author_association as string)
            : '',
      });
    }

    timeline.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    return { timeline, truncated };
  }
}

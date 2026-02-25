/**
 * Issue Conversation Monitor — tracks issues the user has commented on
 * and detects maintainer responses that need attention.
 *
 * Follows the same pattern as PRMonitor: stateless fetch from GitHub,
 * bounded concurrency via worker pool, bot/acknowledgment filtering.
 */

import { Octokit } from '@octokit/rest';
import { getOctokit } from './github.js';
import { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';
import { getStateManager } from './state.js';
import { daysBetween, splitRepo, extractOwnerRepo } from './utils.js';
import { runWorkerPool } from './concurrency.js';
import type { CommentedIssue, IssueConversationStatus } from './types.js';

const MAX_CONCURRENT_REQUESTS = 5;

export class IssueConversationMonitor {
  private octokit: Octokit;
  private stateManager: ReturnType<typeof getStateManager>;

  constructor(githubToken: string) {
    this.octokit = getOctokit(githubToken);
    this.stateManager = getStateManager();
  }

  /**
   * Fetch issues the user has commented on and determine conversation state.
   * Filters out: user-authored issues, user-owned repos, excluded repos/orgs,
   * AI policy blocklisted repos, already-tracked issues, and pull requests.
   */
  async fetchCommentedIssues(maxDays: number = 30): Promise<{ issues: CommentedIssue[]; failures: Array<{ issueUrl: string; error: string }> }> {
    const config = this.stateManager.getState().config;

    if (!config.githubUsername) {
      throw new Error('No GitHub username configured. Run setup first.');
    }

    const username = config.githubUsername;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - maxDays);
    const since = cutoffDate.toISOString().split('T')[0];

    console.error(`Fetching commented issues for @${username} (last ${maxDays} days)...`);

    // Search for open issues the user has commented on, updated within window
    // Single page (100) is sufficient for most users; log if truncated.
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: `commenter:${username} type:issue state:open updated:>=${since}`,
      sort: 'updated',
      order: 'desc',
      per_page: 100,
    });

    if (data.total_count > 100) {
      console.error(`[ISSUE_CONVERSATION] Search returned ${data.total_count} results but only first 100 were fetched. Some commented issues may be missing.`);
    }

    // Build sets for filtering
    const trackedIssues = this.stateManager.getState().activeIssues || [];
    const trackedIssueKeys = new Set(
      trackedIssues
        .filter(i => i.status === 'claimed' || i.status === 'in_progress' || i.status === 'pr_submitted')
        .map(i => `${i.repo}#${i.number}`)
    );
    const blocklist = new Set((config.aiPolicyBlocklist || []).map(r => r.toLowerCase()));

    // Filter out PRs, user-authored issues, excluded repos, blocklisted repos, and already-tracked issues.
    // Also parse repo info for each candidate to avoid re-parsing in analyzeIssueConversation.
    const candidates: Array<{ item: typeof data.items[0]; repoFullName: string }> = [];
    for (const item of data.items) {
      // Defensive: skip pull requests in case type:issue qualifier is unreliable
      if (item.pull_request) continue;

      const parsed = extractOwnerRepo(item.html_url);
      if (!parsed) {
        console.error(`[ISSUE_CONVERSATION] Skipping issue with unparseable URL: ${item.html_url}`);
        continue;
      }

      const { owner, repo } = parsed;
      const repoFullName = `${owner}/${repo}`;

      // Skip issues in user-owned repos (we only care about contributing to others' projects)
      if (owner.toLowerCase() === username.toLowerCase()) continue;

      // Skip user-authored issues
      if (item.user?.login?.toLowerCase() === username.toLowerCase()) continue;

      // Skip excluded repos and orgs
      if (config.excludeRepos.includes(repoFullName)) continue;
      if (config.excludeOrgs?.some(org => owner.toLowerCase() === org.toLowerCase())) continue;

      // Skip blocklisted repos
      if (blocklist.has(repoFullName.toLowerCase())) continue;

      // Skip issues already in the tracked pipeline
      if (trackedIssueKeys.has(`${repoFullName}#${item.number}`)) continue;

      candidates.push({ item, repoFullName });
    }

    console.error(`Found ${candidates.length} commented issues to check`);

    // Fetch comments for each issue using worker pool.
    const results: CommentedIssue[] = [];
    const failures: Array<{ issueUrl: string; error: string }> = [];

    await runWorkerPool(candidates, async ({ item, repoFullName }) => {
      try {
        const issue = await this.analyzeIssueConversation(item, repoFullName, username);
        if (issue) {
          results.push(issue);
        } else {
          failures.push({ issueUrl: item.html_url, error: 'No user comment found despite commenter: search match (possible pagination or eventual consistency)' });
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        failures.push({ issueUrl: item.html_url, error: msg });
        console.error(`Error analyzing issue ${item.html_url}: ${msg}`);
      }
    }, MAX_CONCURRENT_REQUESTS);

    if (failures.length > 0) {
      console.error(`[ISSUE_CONVERSATION] ${failures.length}/${candidates.length} issue analysis call(s) failed`);
    }
    if (failures.length === candidates.length && candidates.length > 0) {
      console.error(`[ISSUE_CONVERSATION_ALL_FAILED] All ${candidates.length} issue analysis call(s) failed. Possible systemic issue (rate limit, auth, network).`);
    }

    // Sort: new_response first, then waiting, then acknowledged
    const statusOrder: Record<IssueConversationStatus, number> = {
      new_response: 0,
      waiting: 1,
      acknowledged: 2,
    };
    results.sort((a, b) => statusOrder[a.status] - statusOrder[b.status]);

    console.error(`Analyzed ${results.length} issue conversations (${results.filter(i => i.status === 'new_response').length} with new responses)`);
    return { issues: results, failures };
  }

  /**
   * Analyze a single issue's comment thread to determine conversation status.
   */
  private async analyzeIssueConversation(
    item: { html_url: string; number: number; title: string; labels?: Array<{ name?: string }> },
    repoFullName: string,
    username: string,
  ): Promise<CommentedIssue | null> {
    const { owner, repo } = splitRepo(repoFullName);

    const comments = await this.octokit.issues.listComments({
      owner,
      repo,
      issue_number: item.number,
      per_page: 100,
    });

    if (comments.data.length === 100) {
      console.error(`[ISSUE_CONVERSATION] Issue ${item.html_url} has 100+ comments; analysis may miss older comments (pagination not implemented)`);
    }

    const timeline: Array<{ author: string; body: string; createdAt: string; isUser: boolean }> = [];
    for (const comment of comments.data) {
      if (!comment.user?.login) continue; // Skip comments from deleted accounts
      const author = comment.user.login;
      timeline.push({
        author,
        body: comment.body || '',
        createdAt: comment.created_at,
        isUser: author.toLowerCase() === username.toLowerCase(),
      });
    }

    timeline.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

    // Find the user's last comment
    let userLastComment: typeof timeline[0] | undefined;
    for (const entry of timeline) {
      if (entry.isUser) userLastComment = entry;
    }

    // If user never commented (shouldn't happen with commenter: search, but be safe)
    if (!userLastComment) {
      console.error(`[ISSUE_CONVERSATION] No user comment found for ${item.html_url} despite commenter: search match`);
      return null;
    }

    const userLastCommentTime = new Date(userLastComment.createdAt);

    // Find maintainer responses after the user's last comment
    let lastResponse: { author: string; body: string; createdAt: string } | undefined;
    for (const entry of timeline) {
      if (entry.isUser) continue;
      if (isBotAuthor(entry.author)) continue;

      const entryTime = new Date(entry.createdAt);
      if (entryTime > userLastCommentTime) {
        // Skip pure acknowledgments
        if (isAcknowledgmentComment(entry.body)) continue;

        lastResponse = {
          author: entry.author,
          body: entry.body.slice(0, 200) + (entry.body.length > 200 ? '...' : ''),
          createdAt: entry.createdAt,
        };
      }
    }

    const labels = (item.labels || []).map(l => l.name || '').filter(Boolean);

    const base = {
      repo: repoFullName,
      number: item.number,
      title: item.title,
      url: item.html_url,
      userLastCommentedAt: userLastComment.createdAt,
      labels,
      daysSinceUserComment: daysBetween(userLastCommentTime, new Date()),
    };

    if (lastResponse) {
      return {
        ...base,
        status: 'new_response' as const,
        lastResponseAuthor: lastResponse.author,
        lastResponseBody: lastResponse.body,
        lastResponseAt: lastResponse.createdAt,
      };
    }

    // No substantive response found. If user is the last non-bot commenter,
    // mark as acknowledged; otherwise mark as waiting.
    const lastNonBotComment = [...timeline].reverse().find(
      e => !isBotAuthor(e.author)
    );
    const status = lastNonBotComment?.isUser ? 'acknowledged' as const : 'waiting' as const;
    return { ...base, status };
  }
}


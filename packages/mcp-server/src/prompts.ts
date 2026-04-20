/**
 * MCP prompt registrations for OSS Autopilot.
 *
 * Registers pre-built prompt workflows that combine tool invocations
 * with structured user messages for common contribution tasks:
 *   - triage: Daily PR triage and prioritization
 *   - respond-to-pr: Draft responses to maintainer feedback
 *   - find-issues: Discover and rank contributable issues
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runDaily, runComments, runSearch, MAX_SEARCH_RESULTS } from '@oss-autopilot/core/commands';
import { errorMessage } from '@oss-autopilot/core';

/** Build a single-message prompt result with a user text message. */
function userMessage(text: string) {
  return {
    messages: [
      {
        role: 'user' as const,
        content: { type: 'text' as const, text },
      },
    ],
  };
}

/**
 * Registers all OSS Autopilot MCP prompts on the given server.
 */
export function registerPrompts(server: McpServer): void {
  // 1. triage — no args, runs daily check and builds triage message
  server.registerPrompt(
    'triage',
    {
      title: 'Triage PRs',
      description: 'Get a prioritized list of PRs needing attention with recommended actions',
    },
    async () => {
      try {
        const data = await runDaily();
        return userMessage(
          `Here is my current OSS contribution status. Help me triage and prioritize:\n\n${data.summary}\n\nActionable issues:\n${JSON.stringify(data.actionableIssues, null, 2)}\n\nFull data:\n${JSON.stringify(data.digest, null, 2)}`,
        );
      } catch (e) {
        console.error('[MCP] Prompt error (triage):', e);
        return userMessage(`Failed to fetch triage data: ${errorMessage(e)}`);
      }
    },
  );

  // 2. respond-to-pr — requires prUrl, fetches PR comments for drafting a response
  server.registerPrompt(
    'respond-to-pr',
    {
      title: 'Respond to PR',
      description: 'Get context for a PR to help draft a response to maintainer feedback',
      argsSchema: {
        prUrl: z.string().url().describe('GitHub PR URL to respond to'),
      },
    },
    async ({ prUrl }) => {
      try {
        const data = await runComments({ prUrl });
        return userMessage(
          `Help me respond to this pull request:\n\nPR: ${data.pr.title} (${data.pr.url})\nState: ${data.pr.state}\n\nReviews:\n${JSON.stringify(data.reviews, null, 2)}\n\nInline comments:\n${JSON.stringify(data.reviewComments, null, 2)}\n\nDiscussion:\n${JSON.stringify(data.issueComments, null, 2)}\n\nPlease help me draft a thoughtful response addressing the feedback.`,
        );
      } catch (e) {
        console.error('[MCP] Prompt error (respond-to-pr):', e);
        return userMessage(`Failed to fetch PR comments: ${errorMessage(e)}`);
      }
    },
  );

  // 3. find-issues — optional maxResults, searches for contributable issues
  server.registerPrompt(
    'find-issues',
    {
      title: 'Find Issues to Work On',
      description: 'Search for good issues to contribute to, ranked by viability',
      argsSchema: {
        maxResults: z.coerce.number().optional().describe('Max issues to return (default: 5)'),
      },
    },
    async ({ maxResults }) => {
      try {
        let capped = maxResults ?? 5;
        if (!Number.isInteger(capped) || capped < 1) capped = 5;
        if (capped > MAX_SEARCH_RESULTS) capped = MAX_SEARCH_RESULTS;
        const data = await runSearch({ maxResults: capped });
        const candidateList = data.candidates
          .map(
            (c, i) =>
              `${i + 1}. [${c.recommendation.toUpperCase()}] ${c.issue.repo}#${c.issue.number}: ${c.issue.title}\n   URL: ${c.issue.url}\n   Score: ${c.viabilityScore}/100\n   Approve: ${c.reasonsToApprove.join(', ') || 'None'}\n   Skip: ${c.reasonsToSkip.join(', ') || 'None'}`,
          )
          .join('\n\n');
        const warning = data.rateLimitWarning ? `\n\nNote: ${data.rateLimitWarning}` : '';
        return userMessage(
          `Here are potential issues I could work on. Help me pick the best one:\n\n${candidateList}${warning}`,
        );
      } catch (e) {
        console.error('[MCP] Prompt error (find-issues):', e);
        return userMessage(`Failed to search for issues: ${errorMessage(e)}`);
      }
    },
  );
}

/**
 * MCP prompt registrations for OSS Autopilot.
 *
 * Registers pre-built prompt workflows that combine tool invocations
 * with structured user messages for common contribution tasks:
 *   - triage: Daily PR triage and prioritization
 *   - respond-to-pr: Draft responses to maintainer feedback
 *   - find-issues: Discover and rank contributable issues
 *   - extract-learnings: Distill durable guidance from past PR feedback (#867)
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runDaily, runComments, runSearch, MAX_SEARCH_RESULTS } from '@oss-autopilot/core/commands';
import { errorMessage } from '@oss-autopilot/core';

/**
 * Subset of `PRCommentBundle` from `@oss-autopilot/core` that we render in the
 * extract-learnings prompt. Inlined as a structural type to avoid pulling in
 * the full implementation module just for a JSON shape.
 */
interface PRCommentBundleShape {
  prUrl: string;
  prTitle: string;
  repo: string;
  mergedAt: string;
  reviews: { author: string; authorAssociation: string; body: string }[];
  reviewComments: { author: string; authorAssociation: string; body: string; path: string }[];
  issueComments: { author: string; authorAssociation: string; body: string }[];
}

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
        // Throw rather than return userMessage so the MCP SDK produces a
        // proper JSON-RPC error. Returning userMessage on failure made the
        // host LLM treat the error as if the user typed it and respond to
        // it as a request (#1203). Mirrors wrapResource() in resources.ts.
        console.error('[MCP] Prompt error (triage):', e);
        throw new Error(`Failed to fetch triage data: ${errorMessage(e)}`, { cause: e });
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
        throw new Error(`Failed to fetch PR comments: ${errorMessage(e)}`, { cause: e });
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
        throw new Error(`Failed to search for issues: ${errorMessage(e)}`, { cause: e });
      }
    },
  );

  // 4. extract-learnings — given a corpus of PR comment bundles, ask the host
  // LLM to distill durable per-repo guidance (#867 PR 5).
  server.registerPrompt(
    'extract-learnings',
    {
      title: 'Extract Per-Repo Learnings',
      description:
        'Given raw PR comment bundles for a repo, produce a structured guidelines document distilling durable maintainer preferences. Filter PR-specific nitpicks; keep general rules. Optional existingGuidelines argument enables incremental updates.',
      argsSchema: {
        repo: z.string().describe('Target repo as owner/repo'),
        corpus: z.string().describe('JSON-serialized array of PRCommentBundle objects from guidelines-fetch-corpus'),
        existingGuidelines: z
          .string()
          .optional()
          .describe('Existing guidelines markdown to update incrementally; omit on first extraction'),
      },
    },
    async ({ repo, corpus, existingGuidelines }) => {
      let bundles: PRCommentBundleShape[];
      try {
        const parsed = JSON.parse(corpus);
        if (!Array.isArray(parsed)) {
          // Throw rather than return userMessage so input-validation errors
          // surface as proper JSON-RPC errors to the host (#1203).
          throw new Error(`Invalid corpus: expected an array of PRCommentBundle objects, got ${typeof parsed}.`);
        }
        bundles = parsed as PRCommentBundleShape[];
      } catch (e) {
        throw new Error(`Invalid corpus JSON: ${errorMessage(e)}`, { cause: e });
      }

      if (bundles.length === 0) {
        return userMessage(
          `No PR comment bundles supplied for ${repo}. Run guidelines-fetch-corpus first, then re-run this prompt with its output.`,
        );
      }

      const prSections = bundles
        .map((b) => {
          const reviews = (b.reviews ?? [])
            .map((r) => `[REVIEW by ${r.author} (${r.authorAssociation})]\n${r.body}`)
            .join('\n\n');
          const inline = (b.reviewComments ?? [])
            .map((c) => `[INLINE on ${c.path} by ${c.author} (${c.authorAssociation})]\n${c.body}`)
            .join('\n\n');
          const issue = (b.issueComments ?? [])
            .map((c) => `[COMMENT by ${c.author} (${c.authorAssociation})]\n${c.body}`)
            .join('\n\n');
          const sections = [reviews, inline, issue].filter((s) => s.length > 0).join('\n\n');
          return `### ${b.prTitle} (${b.prUrl}, merged/closed: ${b.mergedAt})\n${sections}`;
        })
        .join('\n\n---\n\n');

      const existing = existingGuidelines
        ? `\n\nEXISTING GUIDELINES (update incrementally; deduplicate; preserve every rule unless directly contradicted):\n${existingGuidelines}`
        : '';

      const prompt = [
        `Distill durable contribution guidance for ${repo} from the PR review feedback below.`,
        '',
        'Rules for the extraction:',
        '1. KEEP only **durable rules** that apply to future PRs — code style preferences, test requirements, architectural conventions, process expectations, dependency constraints, project philosophy.',
        '2. DISCARD PR-specific nitpicks: "LGTM", "Thanks!", scope-of-this-PR asks, one-time workarounds, status updates, CI flake notes, typo fixes, formatting tweaks on the specific code touched, historical context with no actionable rule.',
        '3. WEIGHT comments by authorAssociation: OWNER, MEMBER, COLLABORATOR carry strong signal; CONTRIBUTOR/NONE only when they articulate a clear project-wide rule.',
        '4. FLAG contradictions between maintainer comments rather than silently picking one side.',
        '5. CAP output at ~6,000 bytes (well under the 8 KB store limit). If the corpus produces more, prefer the rules with strongest signal.',
        '',
        'Output format (single markdown document, exactly five fixed categories plus "Other"):',
        '```markdown',
        `# Contribution Guidelines: ${repo}`,
        "_Auto-generated from contribution history. Last updated: <today's date>._",
        '',
        '## Code Style',
        '- ...',
        '',
        '## Process',
        '- ...',
        '',
        '## Architecture',
        '- ...',
        '',
        '## Testing',
        '- ...',
        '',
        '## Other',
        '- ...',
        '```',
        '',
        existing,
        '',
        'PR comment corpus:',
        '',
        prSections,
        '',
        'After producing the guidelines markdown, call the `guidelines-store` tool with `repo` and `content` to persist the result.',
      ].join('\n');

      return userMessage(prompt);
    },
  );
}

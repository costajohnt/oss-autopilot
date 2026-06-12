import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Mock core dependencies before importing server
vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: vi.fn().mockResolvedValue({
    summary: 'You have 2 open PRs. 1 needs response.',
    actionableIssues: [{ repo: 'octocat/hello-world', number: 42, action: 'respond to review' }],
    digest: { openPRs: 2 },
    capacity: { current: 2, max: 5 },
    briefSummary: '2 open PRs',
  }),
  runComments: vi.fn().mockResolvedValue({
    pr: {
      title: 'Fix typo in README',
      state: 'open',
      url: 'https://github.com/octocat/hello-world/pull/42',
    },
    reviews: [{ user: 'maintainer', state: 'CHANGES_REQUESTED', body: 'Please fix the formatting' }],
    reviewComments: [{ user: 'maintainer', body: 'Indent this line', path: 'README.md', line: 10 }],
    issueComments: [{ user: 'maintainer', body: 'Thanks for the contribution!' }],
    summary: '1 review, 1 inline comment, 1 discussion comment',
  }),
  runSearch: vi.fn().mockResolvedValue({
    candidates: [
      {
        issue: {
          repo: 'octocat/hello-world',
          number: 100,
          title: 'Add dark mode',
          url: 'https://github.com/octocat/hello-world/issues/100',
        },
        recommendation: 'approve',
        reasonsToApprove: ['Good first issue', 'Clear scope'],
        reasonsToSkip: [],
        viabilityScore: 85,
      },
    ],
    rateLimitWarning: undefined,
  }),
  // Stubs for tools.ts imports (not used by prompts but loaded via server.ts)
  runStatus: vi.fn(),
  runStrategy: vi.fn(),
  runVet: vi.fn(),
  runVerifyIssue: vi.fn(),
  runVetList: vi.fn(),
  runTrack: vi.fn(),
  runComplianceScore: vi.fn(),
  runRepoVet: vi.fn(),
  runPost: vi.fn(),
  runClaim: vi.fn(),
  runConfig: vi.fn(),
  runInit: vi.fn(),
  runSetup: vi.fn(),
  runCheckSetup: vi.fn(),
  runStartup: vi.fn(),
  runDismiss: vi.fn(),
  runUndismiss: vi.fn(),
  runMove: vi.fn(),
  runGuidelinesView: vi.fn(),
  runGuidelinesStore: vi.fn(),
  runGuidelinesReset: vi.fn(),
  runFetchCorpus: vi.fn(),
  runFeatures: vi.fn(),
  MAX_SEARCH_RESULTS: 100,
  MAX_FEATURES_RESULTS: 100,
}));

vi.mock('@oss-autopilot/core', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  getStateManager: vi.fn().mockReturnValue({
    getState: vi.fn().mockReturnValue({
      lastDigest: { openPRs: [], shelvedPRs: [] },
    }),
  }),
  getGitHubTokenAsync: vi.fn().mockResolvedValue(null),
  ensureGistPersistence: vi.fn().mockResolvedValue(undefined),
  getSetupKeys: () => ['username', 'languages', 'minStars'],
  getConfigKeys: () => ['username', 'add-label', 'remove-label'],
}));

import { createServer } from './server.js';
import { runDaily, runComments, runSearch } from '@oss-autopilot/core/commands';

describe('MCP prompt registrations', () => {
  let client: Client;

  beforeAll(async () => {
    const server = createServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);

    client = new Client({ name: 'test-client', version: '0.0.0' });
    await client.connect(clientTransport);
  });

  afterAll(async () => {
    await client.close();
  });

  describe('prompt listing', () => {
    it('lists exactly 4 prompts', async () => {
      const result = await client.listPrompts();
      expect(result.prompts).toHaveLength(4);
    });

    it('registers the expected prompt names', async () => {
      const result = await client.listPrompts();
      const names = result.prompts.map((p) => p.name).sort();
      expect(names).toEqual(['extract-learnings', 'find-issues', 'respond-to-pr', 'triage']);
    });

    it('each prompt has a name and description', async () => {
      const result = await client.listPrompts();
      for (const prompt of result.prompts) {
        expect(prompt.name).toBeTruthy();
        expect(prompt.description).toBeTruthy();
        expect(typeof prompt.description).toBe('string');
        expect(prompt.description!.length).toBeGreaterThan(10);
      }
    });
  });

  describe('prompt arguments', () => {
    it('triage has no arguments', async () => {
      const result = await client.listPrompts();
      const triage = result.prompts.find((p) => p.name === 'triage');
      expect(triage).toBeDefined();
      expect(triage!.arguments ?? []).toEqual([]);
    });

    it('respond-to-pr has a required prUrl argument', async () => {
      const result = await client.listPrompts();
      const respondToPr = result.prompts.find((p) => p.name === 'respond-to-pr');
      expect(respondToPr).toBeDefined();
      expect(respondToPr!.arguments).toBeDefined();
      const prUrlArg = respondToPr!.arguments!.find((a) => a.name === 'prUrl');
      expect(prUrlArg).toBeDefined();
      expect(prUrlArg!.required).toBe(true);
    });

    it('find-issues has an optional maxResults argument', async () => {
      const result = await client.listPrompts();
      const findIssues = result.prompts.find((p) => p.name === 'find-issues');
      expect(findIssues).toBeDefined();
      expect(findIssues!.arguments).toBeDefined();
      const maxResultsArg = findIssues!.arguments!.find((a) => a.name === 'maxResults');
      expect(maxResultsArg).toBeDefined();
      expect(maxResultsArg!.required).toBeFalsy();
    });
  });

  describe('prompt execution', () => {
    it('triage returns a user message with summary data', async () => {
      const result = await client.getPrompt({ name: 'triage' });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      expect(result.messages[0].content.type).toBe('text');
      const text = (result.messages[0].content as { type: 'text'; text: string }).text;
      expect(text).toContain('triage and prioritize');
      expect(text).toContain('Actionable issues');
    });

    it('respond-to-pr returns a user message with PR details', async () => {
      const result = await client.getPrompt({
        name: 'respond-to-pr',
        arguments: { prUrl: 'https://github.com/octocat/hello-world/pull/42' },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      const text = (result.messages[0].content as { type: 'text'; text: string }).text;
      expect(text).toContain('Fix typo in README');
      expect(text).toContain('draft a thoughtful response');
    });

    it('find-issues returns a user message with candidates', async () => {
      const result = await client.getPrompt({
        name: 'find-issues',
        arguments: { maxResults: '3' },
      });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe('user');
      const text = (result.messages[0].content as { type: 'text'; text: string }).text;
      expect(text).toContain('Add dark mode');
      expect(text).toContain('APPROVE');
      expect(text).toContain('85/100');
    });
  });

  describe('prompt error handling (#1203)', () => {
    // Prompts now THROW on internal failure rather than return userMessage,
    // so the MCP SDK produces a JSON-RPC error and the host LLM sees a failed
    // prompt invocation rather than treating an error string as user prose.
    // Mirrors the wrapResource pattern in resources.ts.

    it('triage throws when runDaily rejects', async () => {
      vi.mocked(runDaily).mockRejectedValueOnce(new Error('GitHub API rate limit'));

      await expect(client.getPrompt({ name: 'triage' })).rejects.toThrow(
        /Failed to fetch triage data.*GitHub API rate limit/,
      );
    });

    it('respond-to-pr throws when runComments rejects', async () => {
      vi.mocked(runComments).mockRejectedValueOnce(new Error('PR not found'));

      await expect(
        client.getPrompt({
          name: 'respond-to-pr',
          arguments: { prUrl: 'https://github.com/octocat/hello-world/pull/999' },
        }),
      ).rejects.toThrow(/Failed to fetch PR comments.*PR not found/);
    });

    it('find-issues throws when runSearch rejects', async () => {
      vi.mocked(runSearch).mockRejectedValueOnce(new Error('Search quota exceeded'));

      await expect(
        client.getPrompt({
          name: 'find-issues',
          arguments: { maxResults: '5' },
        }),
      ).rejects.toThrow(/Failed to search for issues.*Search quota exceeded/);
    });
  });

  describe('extract-learnings prompt (#867)', () => {
    function getText(result: { messages: { content: unknown }[] }): string {
      return (result.messages[0].content as { type: 'text'; text: string }).text;
    }

    it('builds a structured prompt from a valid corpus', async () => {
      const corpus = JSON.stringify([
        {
          prUrl: 'https://github.com/owner/repo/pull/1',
          prTitle: 'Fix sort order',
          repo: 'owner/repo',
          mergedAt: '2026-04-20T12:00:00Z',
          reviews: [{ author: 'maintainer1', authorAssociation: 'OWNER', body: 'Use camelCase' }],
          reviewComments: [{ author: 'maintainer1', authorAssociation: 'OWNER', body: 'Inline nit', path: 'src/x.ts' }],
          issueComments: [{ author: 'maintainer2', authorAssociation: 'COLLABORATOR', body: 'Tests please' }],
        },
      ]);

      const result = await client.getPrompt({
        name: 'extract-learnings',
        arguments: { repo: 'owner/repo', corpus },
      });

      const text = getText(result);
      expect(text).toContain('Distill durable contribution guidance for owner/repo');
      // Categories from the design log §6
      expect(text).toContain('## Code Style');
      expect(text).toContain('## Process');
      expect(text).toContain('## Architecture');
      expect(text).toContain('## Testing');
      expect(text).toContain('## Other');
      // Per-PR section structure
      expect(text).toContain('### Fix sort order');
      expect(text).toContain('[REVIEW by maintainer1 (OWNER)]');
      expect(text).toContain('[INLINE on src/x.ts by maintainer1 (OWNER)]');
      expect(text).toContain('[COMMENT by maintainer2 (COLLABORATOR)]');
      // Closing instruction
      expect(text).toContain('call the `guidelines-store` tool');
    });

    it('threads existingGuidelines into an incremental update', async () => {
      const corpus = JSON.stringify([
        {
          prUrl: 'https://github.com/owner/repo/pull/2',
          prTitle: 'Refactor parser',
          repo: 'owner/repo',
          mergedAt: '2026-04-21T00:00:00Z',
          reviews: [],
          reviewComments: [],
          issueComments: [{ author: 'm', authorAssociation: 'OWNER', body: 'No new deps' }],
        },
      ]);

      const result = await client.getPrompt({
        name: 'extract-learnings',
        arguments: { repo: 'owner/repo', corpus, existingGuidelines: '## Code Style\n- Existing rule' },
      });

      const text = getText(result);
      expect(text).toContain('EXISTING GUIDELINES');
      expect(text).toContain('Existing rule');
      expect(text).toContain('deduplicate');
    });

    it('throws when corpus is not valid JSON (#1203)', async () => {
      await expect(
        client.getPrompt({
          name: 'extract-learnings',
          arguments: { repo: 'owner/repo', corpus: '{not valid' },
        }),
      ).rejects.toThrow(/Invalid corpus JSON/);
    });

    it('throws when corpus is JSON but not an array (#1203)', async () => {
      await expect(
        client.getPrompt({
          name: 'extract-learnings',
          arguments: { repo: 'owner/repo', corpus: '{"foo":1}' },
        }),
      ).rejects.toThrow(/expected an array/);
    });

    it('returns a friendly message when the corpus array is empty', async () => {
      const result = await client.getPrompt({
        name: 'extract-learnings',
        arguments: { repo: 'owner/repo', corpus: '[]' },
      });

      expect(getText(result)).toContain('No PR comment bundles supplied');
      expect(getText(result)).toContain('guidelines-fetch-corpus');
    });
  });
});

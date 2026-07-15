import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Use vi.hoisted() so mock references are available inside the hoisted vi.mock() factory
const {
  mockRunDaily,
  mockRunSearch,
  mockRunMove,
  mockRunVerifyIssue,
  mockRunGuidelinesList,
  mockRunGuidelinesView,
  mockRunGuidelinesStore,
  mockRunGuidelinesReset,
  mockRunFetchCorpus,
} = vi.hoisted(() => ({
  mockRunDaily: vi.fn(),
  mockRunSearch: vi.fn(),
  mockRunMove: vi.fn(),
  mockRunVerifyIssue: vi.fn(),
  mockRunGuidelinesList: vi.fn(),
  mockRunGuidelinesView: vi.fn(),
  mockRunGuidelinesStore: vi.fn(),
  mockRunGuidelinesReset: vi.fn(),
  mockRunFetchCorpus: vi.fn(),
}));

vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: mockRunDaily,
  runStatus: vi.fn(),
  runStrategy: vi.fn(),
  runSearch: mockRunSearch,
  runVet: vi.fn(),
  runVerifyIssue: mockRunVerifyIssue,
  runVetList: vi.fn(),
  runTrack: vi.fn(),
  runComplianceScore: vi.fn(),
  runRepoVet: vi.fn(),
  runComments: vi.fn(),
  runPost: vi.fn(),
  runClaim: vi.fn(),
  runConfig: vi.fn(),
  runInit: vi.fn(),
  runSetup: vi.fn(),
  runCheckSetup: vi.fn(),
  runStartup: vi.fn(),
  runDismiss: vi.fn(),
  runUndismiss: vi.fn(),
  runMove: mockRunMove,
  runGuidelinesList: mockRunGuidelinesList,
  runGuidelinesView: mockRunGuidelinesView,
  runGuidelinesStore: mockRunGuidelinesStore,
  runGuidelinesReset: mockRunGuidelinesReset,
  runFetchCorpus: mockRunFetchCorpus,
  runFeatures: vi.fn(),
  MAX_SEARCH_RESULTS: 100,
  DEFAULT_SEARCH_RESULTS: 15,
  MAX_FEATURES_RESULTS: 100,
}));

vi.mock('@oss-autopilot/core', async (importOriginal) => ({
  // Real provenance labeler (#1455): the guidelines-get assertions below
  // exercise the actual preamble, not a passthrough.
  labelGuidelinesContent: (await importOriginal<typeof import('@oss-autopilot/core')>()).labelGuidelinesContent,
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  getStateManager: vi.fn().mockReturnValue({
    getState: vi.fn().mockReturnValue({
      lastDigest: { openPRs: [], shelvedPRs: [] },
    }),
    // Per-call state reload (#1439) runs before every tool body.
    isGistMode: vi.fn().mockReturnValue(false),
    reloadIfChanged: vi.fn().mockReturnValue(false),
    refreshFromGist: vi.fn().mockResolvedValue(false),
  }),
  getGitHubTokenAsync: vi.fn().mockResolvedValue(null),
  ensureGistPersistence: vi.fn().mockResolvedValue(undefined),
  // Config-key registry access for the config tool's key enum (#1053).
  // Return a small known-set so the MCP schema validates against real keys.
  getSetupKeys: () => ['username', 'languages', 'minStars'],
  getConfigKeys: () => ['username', 'add-label', 'remove-label'],
  // Error classes referenced by wrapTool's concurrency/config carve-outs
  // (#1439/#1441) — the whole module is mocked, so instanceof checks in
  // tools.ts run against these.
  ConfigurationError: class ConfigurationError extends Error {},
  ConcurrencyError: class ConcurrencyError extends Error {},
  GistConcurrencyError: class GistConcurrencyError extends Error {},
}));

import { createServer } from './server.js';

// callTool's return type is a union whose legacy CompatibilityCallToolResult
// arm types `content` as `unknown`; every tool in this suite returns text content.
type ToolCallResult = Awaited<ReturnType<Client['callTool']>>;

function firstTextContent(result: ToolCallResult): { type: string; text: string } {
  return (result.content as Array<{ type: string; text: string }>)[0];
}

describe('tool execution', () => {
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

  describe('wrapTool ok/err paths', () => {
    it('daily success returns JSON data via ok()', async () => {
      const mockData = { summary: 'All clear', openPRs: 0 };
      mockRunDaily.mockResolvedValueOnce(mockData);

      const result = await client.callTool({ name: 'daily', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(result.content).toHaveLength(1);
      const content = firstTextContent(result);
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed.summary).toBe('All clear');
    });

    it('daily error returns isError via err()', async () => {
      mockRunDaily.mockRejectedValueOnce(new Error('GitHub API rate limit'));

      const result = await client.callTool({ name: 'daily', arguments: {} });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const content = firstTextContent(result);
      expect(content.text).toContain('GitHub API rate limit');
    });
  });

  describe('search validation', () => {
    it('uses default maxResults of 15 when not provided', async () => {
      mockRunSearch.mockResolvedValueOnce({ candidates: [] });

      await client.callTool({ name: 'search', arguments: {} });

      expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 15 });
    });

    // Previously the handler silently clamped maxResults > 100 to the cap.
    // After #1058 M41, the Zod schema rejects values over the cap with a
    // proper JSON-RPC -32602 InvalidParams error so misuse is surfaced
    // rather than silently papered over.
    it('rejects maxResults exceeding the cap at the schema layer (#1058 M41)', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: 500 },
      });

      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/maxresults/i);
    });

    it('rejects invalid maxResults (-1) at the schema layer', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: -1 },
      });

      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      // Zod's structured error payload surfaces the field name.
      expect(content.text).toMatch(/maxresults/i);
    });

    it('rejects non-integer maxResults (1.5) at the schema layer', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: 1.5 },
      });

      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/maxresults/i);
    });
  });

  // The `shelve`/`unshelve` tool aliases were retired in #1466; `move`
  // covers both transitions directly.
  describe('move delegation', () => {
    it('move delegates to runMove with the given target', async () => {
      mockRunMove.mockResolvedValueOnce({ success: true });

      await client.callTool({
        name: 'move',
        arguments: { prUrl: 'https://github.com/octocat/hello-world/pull/42', target: 'shelved' },
      });

      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/octocat/hello-world/pull/42',
        target: 'shelved',
      });
    });
  });

  // #1421: nothing executed the verify-issue handler — a miswired
  // wrapTool(runVet) would have passed the whole suite.
  describe('verify-issue delegation', () => {
    it('verify-issue delegates to runVerifyIssue with the issueUrl', async () => {
      mockRunVerifyIssue.mockResolvedValueOnce({ verdict: 'available' });

      const result = await client.callTool({
        name: 'verify-issue',
        arguments: { issueUrl: 'https://github.com/octocat/hello-world/issues/7' },
      });

      expect(mockRunVerifyIssue).toHaveBeenCalledWith({
        issueUrl: 'https://github.com/octocat/hello-world/issues/7',
      });
      expect(result.isError).toBeFalsy();
      const content = firstTextContent(result);
      expect(JSON.parse(content.text)).toEqual({ verdict: 'available' });
    });

    it('rejects a non-issue URL at the schema layer', async () => {
      mockRunVerifyIssue.mockClear();
      const result = await client.callTool({
        name: 'verify-issue',
        arguments: { issueUrl: 'https://github.com/octocat/hello-world/pull/7' },
      });

      expect(result.isError).toBe(true);
      expect(mockRunVerifyIssue).not.toHaveBeenCalled();
    });
  });

  // ── #1208 M4: MCP execution coverage for the 4 guidelines tools ─────
  // Previously only `tools.test.ts` checked these were registered; nothing
  // verified that callTool actually delegates to the right run* function or
  // that the input schemas reject malformed args at the MCP boundary.

  describe('guidelines-list tool', () => {
    it('delegates to runGuidelinesList and returns the repo list', async () => {
      mockRunGuidelinesList.mockResolvedValueOnce({
        repos: ['owner/repo-a', 'owner/repo-b'],
        count: 2,
        storageMode: 'gist',
      });

      const result = await client.callTool({ name: 'guidelines-list', arguments: {} });

      expect(result.isError).toBeFalsy();
      expect(mockRunGuidelinesList).toHaveBeenCalledOnce();
      const content = firstTextContent(result);
      const parsed = JSON.parse(content.text);
      expect(parsed.repos).toEqual(['owner/repo-a', 'owner/repo-b']);
      expect(parsed.count).toBe(2);
    });
  });

  describe('guidelines-get tool', () => {
    it('delegates to runGuidelinesView and returns content', async () => {
      mockRunGuidelinesView.mockResolvedValueOnce({
        repo: 'owner/repo',
        content: '# rules',
        byteSize: 7,
        exists: true,
        storageMode: 'gist',
      });

      const result = await client.callTool({
        name: 'guidelines-get',
        arguments: { repo: 'owner/repo' },
      });

      expect(result.isError).toBeFalsy();
      expect(mockRunGuidelinesView).toHaveBeenCalledWith({ repo: 'owner/repo' });
      // #1455: stored guidelines are LLM-distilled from an untrusted public
      // corpus — the MCP read surface prefixes a provenance note.
      const parsed = JSON.parse(firstTextContent(result).text) as { content: string };
      expect(parsed.content.startsWith('> Provenance: project-supplied guidelines')).toBe(true);
      expect(parsed.content.endsWith('# rules')).toBe(true);
    });

    it('passes null content through without a provenance note (#1455)', async () => {
      mockRunGuidelinesView.mockResolvedValueOnce({
        repo: 'owner/repo',
        content: null,
        byteSize: 0,
        exists: false,
        storageMode: 'gist',
      });

      const result = await client.callTool({
        name: 'guidelines-get',
        arguments: { repo: 'owner/repo' },
      });

      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(firstTextContent(result).text) as { content: string | null };
      expect(parsed.content).toBeNull();
    });

    it('rejects malformed repo identifier at the schema layer', async () => {
      const result = await client.callTool({
        name: 'guidelines-get',
        arguments: { repo: 'not-a-repo' },
      });
      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/owner\/repo/i);
    });
  });

  describe('guidelines-store tool', () => {
    it('delegates to runGuidelinesStore with repo + content', async () => {
      mockRunGuidelinesStore.mockResolvedValueOnce({ repo: 'owner/repo', byteSize: 5, stored: true });

      await client.callTool({
        name: 'guidelines-store',
        arguments: { repo: 'owner/repo', content: 'rules' },
      });

      expect(mockRunGuidelinesStore).toHaveBeenCalledWith({ repo: 'owner/repo', content: 'rules' });
    });

    it('rejects empty content at the schema layer (#1208 M4)', async () => {
      const result = await client.callTool({
        name: 'guidelines-store',
        arguments: { repo: 'owner/repo', content: '' },
      });
      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/content/i);
    });

    it('rejects content exceeding 8 KB cap at the schema layer', async () => {
      const oversized = 'a'.repeat(8193);
      const result = await client.callTool({
        name: 'guidelines-store',
        arguments: { repo: 'owner/repo', content: oversized },
      });
      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/8\s*KB|content/i);
    });
  });

  describe('guidelines-reset tool', () => {
    it('delegates to runGuidelinesReset', async () => {
      mockRunGuidelinesReset.mockResolvedValueOnce({ repo: 'owner/repo', deleted: true });

      await client.callTool({
        name: 'guidelines-reset',
        arguments: { repo: 'owner/repo' },
      });

      expect(mockRunGuidelinesReset).toHaveBeenCalledWith({ repo: 'owner/repo' });
    });
  });

  describe('guidelines-fetch-corpus tool', () => {
    it('delegates to runFetchCorpus with all optional args', async () => {
      mockRunFetchCorpus.mockResolvedValueOnce({ repo: 'owner/repo', bundles: [], prCount: 0, skipped: 0 });

      await client.callTool({
        name: 'guidelines-fetch-corpus',
        arguments: { repo: 'owner/repo', limit: 3, forceRefetch: true },
      });

      expect(mockRunFetchCorpus).toHaveBeenCalledWith({
        repo: 'owner/repo',
        limit: 3,
        forceRefetch: true,
      });
    });

    it('passes undefined limit/forceRefetch when omitted', async () => {
      mockRunFetchCorpus.mockResolvedValueOnce({ repo: 'owner/repo', bundles: [], prCount: 0, skipped: 0 });

      await client.callTool({
        name: 'guidelines-fetch-corpus',
        arguments: { repo: 'owner/repo' },
      });

      expect(mockRunFetchCorpus).toHaveBeenCalledWith({
        repo: 'owner/repo',
        limit: undefined,
        forceRefetch: undefined,
      });
    });

    it('rejects limit > 10 at the schema layer', async () => {
      const result = await client.callTool({
        name: 'guidelines-fetch-corpus',
        arguments: { repo: 'owner/repo', limit: 50 },
      });
      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toMatch(/limit/i);
    });

    it('surfaces runFetchCorpus errors via wrapTool error envelope', async () => {
      mockRunFetchCorpus.mockRejectedValueOnce(new Error('GitHub rate limit exceeded'));

      const result = await client.callTool({
        name: 'guidelines-fetch-corpus',
        arguments: { repo: 'owner/repo' },
      });

      expect(result.isError).toBe(true);
      const content = firstTextContent(result);
      expect(content.text).toContain('GitHub rate limit exceeded');
    });
  });
});

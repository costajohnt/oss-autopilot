import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Use vi.hoisted() so mock references are available inside the hoisted vi.mock() factory
const {
  mockRunDaily,
  mockRunSearch,
  mockRunMove,
  mockRunGuidelinesView,
  mockRunGuidelinesStore,
  mockRunGuidelinesReset,
  mockRunFetchCorpus,
} = vi.hoisted(() => ({
  mockRunDaily: vi.fn(),
  mockRunSearch: vi.fn(),
  mockRunMove: vi.fn(),
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
  runGuidelinesView: mockRunGuidelinesView,
  runGuidelinesStore: mockRunGuidelinesStore,
  runGuidelinesReset: mockRunGuidelinesReset,
  runFetchCorpus: mockRunFetchCorpus,
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
  // Config-key registry access for the config tool's key enum (#1053).
  // Return a small known-set so the MCP schema validates against real keys.
  getSetupKeys: () => ['username', 'languages', 'minStars'],
  getConfigKeys: () => ['username', 'add-label', 'remove-label'],
}));

import { createServer } from './server.js';

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
      const content = result.content[0] as { type: string; text: string };
      expect(content.type).toBe('text');
      const parsed = JSON.parse(content.text);
      expect(parsed.summary).toBe('All clear');
    });

    it('daily error returns isError via err()', async () => {
      mockRunDaily.mockRejectedValueOnce(new Error('GitHub API rate limit'));

      const result = await client.callTool({ name: 'daily', arguments: {} });

      expect(result.isError).toBe(true);
      expect(result.content).toHaveLength(1);
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('GitHub API rate limit');
    });
  });

  describe('search validation', () => {
    it('uses default maxResults of 5 when not provided', async () => {
      mockRunSearch.mockResolvedValueOnce({ candidates: [] });

      await client.callTool({ name: 'search', arguments: {} });

      expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 5 });
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
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toMatch(/maxresults/i);
    });

    it('rejects invalid maxResults (-1) at the schema layer', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: -1 },
      });

      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
      // Zod's structured error payload surfaces the field name.
      expect(content.text).toMatch(/maxresults/i);
    });

    it('rejects non-integer maxResults (1.5) at the schema layer', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: 1.5 },
      });

      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toMatch(/maxresults/i);
    });
  });

  describe('shelve/unshelve delegation', () => {
    it('shelve delegates to runMove with target=shelved', async () => {
      mockRunMove.mockResolvedValueOnce({ success: true });

      await client.callTool({
        name: 'shelve',
        arguments: { prUrl: 'https://github.com/octocat/hello-world/pull/42' },
      });

      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/octocat/hello-world/pull/42',
        target: 'shelved',
      });
    });

    it('unshelve delegates to runMove with target=auto', async () => {
      mockRunMove.mockResolvedValueOnce({ success: true });

      await client.callTool({
        name: 'unshelve',
        arguments: { prUrl: 'https://github.com/octocat/hello-world/pull/42' },
      });

      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/octocat/hello-world/pull/42',
        target: 'auto',
      });
    });
  });

  // ── #1208 M4: MCP execution coverage for the 4 guidelines tools ─────
  // Previously only `tools.test.ts` checked these were registered; nothing
  // verified that callTool actually delegates to the right run* function or
  // that the input schemas reject malformed args at the MCP boundary.

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
    });

    it('rejects malformed repo identifier at the schema layer', async () => {
      const result = await client.callTool({
        name: 'guidelines-get',
        arguments: { repo: 'not-a-repo' },
      });
      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
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
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toMatch(/content/i);
    });

    it('rejects content exceeding 8 KB cap at the schema layer', async () => {
      const oversized = 'a'.repeat(8193);
      const result = await client.callTool({
        name: 'guidelines-store',
        arguments: { repo: 'owner/repo', content: oversized },
      });
      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
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
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toMatch(/limit/i);
    });

    it('surfaces runFetchCorpus errors via wrapTool error envelope', async () => {
      mockRunFetchCorpus.mockRejectedValueOnce(new Error('GitHub rate limit exceeded'));

      const result = await client.callTool({
        name: 'guidelines-fetch-corpus',
        arguments: { repo: 'owner/repo' },
      });

      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('GitHub rate limit exceeded');
    });
  });
});

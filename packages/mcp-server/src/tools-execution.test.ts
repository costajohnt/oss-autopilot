import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Use vi.hoisted() so mock references are available inside the hoisted vi.mock() factory
const { mockRunDaily, mockRunSearch, mockRunMove } = vi.hoisted(() => ({
  mockRunDaily: vi.fn(),
  mockRunSearch: vi.fn(),
  mockRunMove: vi.fn(),
}));

vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: mockRunDaily,
  runStatus: vi.fn(),
  runSearch: mockRunSearch,
  runVet: vi.fn(),
  runVetList: vi.fn(),
  runTrack: vi.fn(),
  runUntrack: vi.fn(),
  runRead: vi.fn(),
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
  MAX_SEARCH_RESULTS: 100,
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

    it('caps maxResults at 100 when exceeded', async () => {
      mockRunSearch.mockResolvedValueOnce({ candidates: [] });

      await client.callTool({ name: 'search', arguments: { maxResults: 500 } });

      expect(mockRunSearch).toHaveBeenCalledWith({ maxResults: 100 });
    });

    it('returns error for invalid maxResults (-1)', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: -1 },
      });

      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Invalid maxResults');
    });

    it('returns error for non-integer maxResults (1.5)', async () => {
      const result = await client.callTool({
        name: 'search',
        arguments: { maxResults: 1.5 },
      });

      expect(result.isError).toBe(true);
      const content = result.content[0] as { type: string; text: string };
      expect(content.text).toContain('Invalid maxResults');
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
});

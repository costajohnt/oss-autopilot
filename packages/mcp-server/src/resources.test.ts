import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

// Mock core dependencies before importing server
vi.mock('@oss-autopilot/core/commands', () => ({
  runStatus: vi.fn().mockResolvedValue({
    success: true,
    data: { openPRs: 2, shelvedPRs: 1 },
  }),
  runConfig: vi.fn().mockResolvedValue({
    success: true,
    data: { languages: ['typescript'], username: 'testuser' },
  }),
  // Stubs for tools.ts imports (not used by resources but loaded via server.ts)
  runDaily: vi.fn(),
  runSearch: vi.fn(),
  runVet: vi.fn(),
  runVetList: vi.fn(),
  runTrack: vi.fn(),
  runComplianceScore: vi.fn(),
  runRepoVet: vi.fn(),
  runComments: vi.fn(),
  runPost: vi.fn(),
  runClaim: vi.fn(),
  runInit: vi.fn(),
  runSetup: vi.fn(),
  runCheckSetup: vi.fn(),
  runStartup: vi.fn(),
  runShelve: vi.fn(),
  runUnshelve: vi.fn(),
  runDismiss: vi.fn(),
  runUndismiss: vi.fn(),
  runMove: vi.fn(),
  MAX_SEARCH_RESULTS: 100,
}));

vi.mock('@oss-autopilot/core', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  splitRepo: (fullName: string) => {
    const [owner, repo] = fullName.split('/');
    return { owner, repo };
  },
  getGitHubTokenAsync: vi.fn().mockResolvedValue(null),
  ensureGistPersistence: vi.fn().mockResolvedValue(undefined),
  getSetupKeys: () => ['username', 'languages', 'minStars'],
  getConfigKeys: () => ['username', 'add-label', 'remove-label'],
  getStateManager: vi.fn().mockReturnValue({
    listGuidelinesRepos: vi.fn().mockReturnValue([]),
    getGuidelines: vi.fn().mockReturnValue(null),
    getState: vi.fn().mockReturnValue({
      lastDigest: {
        generatedAt: '2026-02-28T12:00:00Z',
        openPRs: [
          {
            id: 1,
            url: 'https://github.com/octocat/hello-world/pull/42',
            repo: 'octocat/hello-world',
            number: 42,
            title: 'Fix typo in README',
            status: 'waiting_on_maintainer',
            waitReason: 'pending_review',
            stalenessTier: 'active',
            displayLabel: '[Waiting for Review]',
            displayDescription: 'Waiting for maintainer review',
            createdAt: '2026-02-20T10:00:00Z',
            updatedAt: '2026-02-27T15:00:00Z',
            daysSinceActivity: 1,
          },
          {
            id: 2,
            url: 'https://github.com/octocat/spoon-knife/pull/7',
            repo: 'octocat/spoon-knife',
            number: 7,
            title: 'Add contributing guide',
            status: 'needs_addressing',
            actionReason: 'needs_response',
            stalenessTier: 'active',
            displayLabel: '[Needs Response]',
            displayDescription: '@maintainer commented',
            createdAt: '2026-02-18T08:00:00Z',
            updatedAt: '2026-02-28T09:00:00Z',
            daysSinceActivity: 0,
          },
        ],
        shelvedPRs: [
          {
            number: 99,
            url: 'https://github.com/octocat/hello-world/pull/99',
            title: 'Shelved PR',
            repo: 'octocat/hello-world',
            daysSinceActivity: 14,
            status: 'waiting_on_maintainer',
          },
        ],
      },
    }),
  }),
}));

import { createServer } from './server.js';
import { runStatus } from '@oss-autopilot/core/commands';
import { getStateManager } from '@oss-autopilot/core';

describe('MCP resource registrations', () => {
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

  describe('resource listing', () => {
    it('lists at least 4 static resources', async () => {
      const result = await client.listResources();
      expect(result.resources.length).toBeGreaterThanOrEqual(4);
    });

    it('lists at least 1 resource template', async () => {
      const result = await client.listResourceTemplates();
      expect(result.resourceTemplates.length).toBeGreaterThanOrEqual(1);
    });

    it('each static resource has name, uri, and mimeType', async () => {
      const result = await client.listResources();
      for (const resource of result.resources) {
        expect(resource.name).toBeTruthy();
        expect(resource.uri).toBeTruthy();
        expect(resource.mimeType).toBe('application/json');
      }
    });

    it('registers the expected static resource URIs', async () => {
      const result = await client.listResources();
      const uris = result.resources.map((r) => r.uri);
      expect(uris).toContain('oss://status');
      expect(uris).toContain('oss://config');
      expect(uris).toContain('oss://prs');
      expect(uris).toContain('oss://prs/shelved');
    });

    it('pr-detail template has the correct uriTemplate', async () => {
      const result = await client.listResourceTemplates();
      const prTemplate = result.resourceTemplates.find((t) => t.name === 'pr-detail');
      expect(prTemplate).toBeDefined();
      expect(prTemplate!.uriTemplate).toBe('oss://pr/{owner}/{repo}/{number}');
    });
  });

  describe('reading static resources', () => {
    it('reads oss://status and returns JSON', async () => {
      const result = await client.readResource({ uri: 'oss://status' });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('oss://status');
      expect(result.contents[0].mimeType).toBe('application/json');
      const data = JSON.parse(result.contents[0].text as string);
      expect(data.success).toBe(true);
    });

    it('reads oss://config and returns JSON', async () => {
      const result = await client.readResource({ uri: 'oss://config' });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('oss://config');
      expect(result.contents[0].mimeType).toBe('application/json');
      const data = JSON.parse(result.contents[0].text as string);
      expect(data.success).toBe(true);
    });

    it('reads oss://prs and returns open PRs array', async () => {
      const result = await client.readResource({ uri: 'oss://prs' });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('oss://prs');
      const data = JSON.parse(result.contents[0].text as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(2);
      expect(data[0].repo).toBe('octocat/hello-world');
      expect(data[0].number).toBe(42);
    });

    it('reads oss://prs/shelved and returns shelved PRs array', async () => {
      const result = await client.readResource({ uri: 'oss://prs/shelved' });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('oss://prs/shelved');
      const data = JSON.parse(result.contents[0].text as string);
      expect(Array.isArray(data)).toBe(true);
      expect(data).toHaveLength(1);
      expect(data[0].number).toBe(99);
      expect(data[0].status).toBe('waiting_on_maintainer');
    });
  });

  describe('reading dynamic pr-detail resource', () => {
    it('returns PR detail for a known PR', async () => {
      const result = await client.readResource({
        uri: 'oss://pr/octocat/hello-world/42',
      });
      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].uri).toBe('oss://pr/octocat/hello-world/42');
      const data = JSON.parse(result.contents[0].text as string);
      expect(data.repo).toBe('octocat/hello-world');
      expect(data.number).toBe(42);
      expect(data.title).toBe('Fix typo in README');
    });

    it('rejects read for an unknown PR (#957)', async () => {
      await expect(client.readResource({ uri: 'oss://pr/octocat/hello-world/999' })).rejects.toThrow(/not found/);
    });

    it('lists known PRs via the template list callback', async () => {
      const result = await client.listResources();
      // The template list callback populates resources from openPRs
      const prResources = result.resources.filter((r) => r.uri.startsWith('oss://pr/'));
      expect(prResources.length).toBeGreaterThanOrEqual(2);

      const uris = prResources.map((r) => r.uri);
      expect(uris).toContain('oss://pr/octocat/hello-world/42');
      expect(uris).toContain('oss://pr/octocat/spoon-knife/7');
    });

    it('rejects read for invalid PR number (NaN) (#957)', async () => {
      await expect(client.readResource({ uri: 'oss://pr/octocat/hello-world/abc' })).rejects.toThrow(
        /Invalid PR number/,
      );
    });
  });

  describe('resource error handling (#957)', () => {
    // Resource failures now propagate as JSON-RPC errors instead of being
    // swallowed as 200 OK payloads with `{ error: "..." }` in the body.
    // Clients that do not introspect the JSON no longer mistake failures for
    // successful reads.

    it('wrapResource rejects readResource when the underlying command throws', async () => {
      vi.mocked(runStatus).mockRejectedValueOnce(new Error('State file not found'));
      await expect(client.readResource({ uri: 'oss://status' })).rejects.toThrow(/State file not found/);
    });

    it('template list propagates state errors instead of returning an empty list', async () => {
      vi.mocked(getStateManager).mockImplementationOnce(() => {
        throw new Error('State corrupted');
      });
      await expect(client.listResources()).rejects.toThrow(/State corrupted/);
    });

    it('pr-detail read propagates unexpected exceptions', async () => {
      vi.mocked(getStateManager).mockImplementationOnce(() => {
        throw new Error('Unexpected state error');
      });
      await expect(client.readResource({ uri: 'oss://pr/octocat/hello-world/42' })).rejects.toThrow(
        /Unexpected state error/,
      );
    });
  });

  // ── #1208 M4: repo-guidelines resource read coverage ────────────────────
  // Previously the test suite only checked that the resource was registered
  // via the static-resource count assertion. Nothing exercised the actual
  // template read path, so a regression in `getGuidelines` plumbing or the
  // template URI parsing would not surface.

  describe('repo-guidelines resource (#1208 M4)', () => {
    it('returns markdown content when the repo has guidelines', async () => {
      vi.mocked(getStateManager).mockReturnValueOnce({
        listGuidelinesRepos: vi.fn().mockReturnValue(['octocat/hello-world']),
        getGuidelines: vi.fn().mockReturnValue('# Rules\n- be nice'),
        getState: vi.fn(),
      } as never);

      const result = await client.readResource({
        uri: 'oss://repo/octocat/hello-world/guidelines',
      });

      expect(result.contents).toHaveLength(1);
      expect(result.contents[0].mimeType).toBe('text/markdown');
      expect(result.contents[0].text).toBe('# Rules\n- be nice');
    });

    it('throws when no guidelines are stored for the repo', async () => {
      vi.mocked(getStateManager).mockReturnValueOnce({
        listGuidelinesRepos: vi.fn().mockReturnValue([]),
        getGuidelines: vi.fn().mockReturnValue(null),
        getState: vi.fn(),
      } as never);

      await expect(client.readResource({ uri: 'oss://repo/octocat/missing/guidelines' })).rejects.toThrow(
        /No guidelines stored for octocat\/missing/,
      );
    });

    it('lists known repos via the template list callback', async () => {
      vi.mocked(getStateManager).mockReturnValue({
        listGuidelinesRepos: vi.fn().mockReturnValue(['octocat/hello-world', 'octocat/spoon-knife']),
        getGuidelines: vi.fn(),
        getState: vi.fn().mockReturnValue({
          lastDigest: { generatedAt: '', openPRs: [], shelvedPRs: [], digestType: 'standard' as const },
        }),
      } as never);

      const result = await client.listResources();
      const guidelinesUris = result.resources.filter((r) => r.uri.startsWith('oss://repo/')).map((r) => r.uri);
      expect(guidelinesUris).toContain('oss://repo/octocat/hello-world/guidelines');
      expect(guidelinesUris).toContain('oss://repo/octocat/spoon-knife/guidelines');
    });
  });
});

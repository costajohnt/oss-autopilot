/**
 * Regression tests for ensureGistInit retry semantics (#1368).
 *
 * The old implementation flipped a module-level `gistInitDone = true`
 * BEFORE awaiting the token fetch and ensureGistPersistence(). One
 * transient failure therefore permanently disabled Gist init for the
 * process: every later tool call skipped initialization and gist-mode
 * mutations silently landed in local state only.
 *
 * These tests drive real MCP tool calls through an in-memory transport
 * and pin the intended semantics: failure surfaces as a tool error and
 * clears the memo (next call retries), success is memoized, and
 * concurrent first calls share a single init.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const { mockGetGitHubTokenAsync, mockEnsureGistPersistence, mockRunStatus } = vi.hoisted(() => ({
  mockGetGitHubTokenAsync: vi.fn(),
  mockEnsureGistPersistence: vi.fn(),
  mockRunStatus: vi.fn(),
}));

vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: vi.fn(),
  runStatus: mockRunStatus,
  runStrategy: vi.fn(),
  runSearch: vi.fn(),
  runFeatures: vi.fn(),
  runVet: vi.fn(),
  runVerifyIssue: vi.fn(),
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
  runMove: vi.fn(),
  // #1421 top-up: registration touches these (guidelines list + the
  // dynamically imported state commands) — without them a tool call in this
  // suite would land on undefined instead of a mock.
  runGuidelinesList: vi.fn(),
  runStateShow: vi.fn(),
  runStateSync: vi.fn(),
  runStateUnlink: vi.fn(),
  runGuidelinesView: vi.fn(),
  runGuidelinesStore: vi.fn(),
  runGuidelinesReset: vi.fn(),
  runFetchCorpus: vi.fn(),
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
  getGitHubTokenAsync: mockGetGitHubTokenAsync,
  ensureGistPersistence: mockEnsureGistPersistence,
  getSetupKeys: () => ['username'],
  getConfigKeys: () => ['username'],
}));

/**
 * Build a fresh server + client pair from a fresh module graph so the
 * module-level init memo in tools.ts starts clean for every test.
 */
async function freshClient(): Promise<Client> {
  const { createServer } = await import('./server.js');
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'gist-init-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('ensureGistInit retry semantics (#1368)', () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetModules();
    mockGetGitHubTokenAsync.mockReset().mockResolvedValue('test-token');
    mockEnsureGistPersistence.mockReset().mockResolvedValue();
    mockRunStatus.mockReset().mockResolvedValue({ ok: true });
    client = await freshClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('a transient init failure surfaces as a tool error and the next call retries init', async () => {
    mockGetGitHubTokenAsync.mockRejectedValueOnce(new Error('transient token failure'));

    const first = await client.callTool({ name: 'status', arguments: {} });
    expect(first.isError).toBe(true);
    expect(mockEnsureGistPersistence).not.toHaveBeenCalled();

    const second = await client.callTool({ name: 'status', arguments: {} });
    expect(second.isError).toBeFalsy();
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
    expect(mockEnsureGistPersistence).toHaveBeenCalledWith('test-token');
  });

  it('successful init is memoized: later calls do not re-run it', async () => {
    await client.callTool({ name: 'status', arguments: {} });
    await client.callTool({ name: 'status', arguments: {} });

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
  });

  it('concurrent first calls share a single init', async () => {
    let release!: () => void;
    mockGetGitHubTokenAsync.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = () => resolve('test-token');
        }),
    );

    const a = client.callTool({ name: 'status', arguments: {} });
    const b = client.callTool({ name: 'status', arguments: {} });
    // Let both requests reach ensureGistInit before the token fetch resolves.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();

    const [resultA, resultB] = await Promise.all([a, b]);
    expect(resultA.isError).toBeFalsy();
    expect(resultB.isError).toBeFalsy();
    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
  });
});

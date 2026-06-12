/**
 * Regression tests for the per-tool-call state reload and the
 * reload-reapply concurrency retry (#1439).
 *
 * A long-lived stdio MCP server used to load state once at boot and never
 * reload it. In local mode, any external CLI write bumped the state.json
 * mtime, and every subsequent MCP mutation failed the save-time
 * compare-and-swap with ConcurrencyError until process restart — the
 * baseline mtime only updates on a successful save or reload, neither of
 * which happened after the throw. Reads served boot-time state forever.
 *
 * The fix mirrors the dashboard server's contract (#1397): reload
 * externally-written state before every tool body (reloadIfChanged in
 * local mode, throttled refreshFromGist in gist mode), and on a
 * concurrency conflict reload once more and re-run the command's own
 * mutation — a second consecutive conflict surfaces as the normal error.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const {
  mockGetGitHubTokenAsync,
  mockEnsureGistPersistence,
  mockRunStatus,
  mockRunMove,
  mockStateManager,
  MockConcurrencyError,
  MockGistConcurrencyError,
} = vi.hoisted(() => {
  // Stand-ins for the core error classes (the whole module is mocked, so
  // tools.ts's instanceof checks run against THESE classes).
  class MockConcurrencyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConcurrencyError';
    }
  }
  class MockGistConcurrencyError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'GistConcurrencyError';
    }
  }
  return {
    mockGetGitHubTokenAsync: vi.fn(),
    mockEnsureGistPersistence: vi.fn(),
    mockRunStatus: vi.fn(),
    mockRunMove: vi.fn(),
    mockStateManager: {
      getState: vi.fn(),
      isGistMode: vi.fn(),
      reloadIfChanged: vi.fn(),
      refreshFromGist: vi.fn(),
    },
    MockConcurrencyError,
    MockGistConcurrencyError,
  };
});

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
  runMove: mockRunMove,
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
  getStateManager: vi.fn(() => mockStateManager),
  getGitHubTokenAsync: mockGetGitHubTokenAsync,
  ensureGistPersistence: mockEnsureGistPersistence,
  getSetupKeys: () => ['username'],
  getConfigKeys: () => ['username'],
  ConcurrencyError: MockConcurrencyError,
  GistConcurrencyError: MockGistConcurrencyError,
  ConfigurationError: class ConfigurationError extends Error {},
}));

const PR_URL = 'https://github.com/octocat/hello-world/pull/42';

/**
 * Build a fresh server + client pair from a fresh module graph so the
 * module-level init memo in tools.ts starts clean for every test.
 */
async function freshClient(): Promise<Client> {
  const { createServer } = await import('./server.js');
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'state-reload-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

describe('per-tool-call state reload + concurrency retry (#1439)', () => {
  let client: Client;

  beforeEach(async () => {
    vi.resetModules();
    mockGetGitHubTokenAsync.mockReset().mockResolvedValue('test-token');
    mockEnsureGistPersistence.mockReset().mockResolvedValue('local-mode');
    mockRunStatus.mockReset();
    mockRunMove.mockReset();
    mockStateManager.getState.mockReset().mockReturnValue({ lastDigest: { openPRs: [], shelvedPRs: [] } });
    mockStateManager.isGistMode.mockReset().mockReturnValue(false);
    mockStateManager.reloadIfChanged.mockReset().mockReturnValue(false);
    mockStateManager.refreshFromGist.mockReset().mockResolvedValue(false);
    client = await freshClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('an external state.json write between two MCP calls does not brick the second mutation', async () => {
    // Simulated mtime CAS: the mutation conflicts iff an external write has
    // not been absorbed by a reload; reloadIfChanged absorbs it — exactly
    // the StateManager contract (reloadIfChanged updates the mtime baseline).
    let externalWritePending = false;
    mockStateManager.reloadIfChanged.mockImplementation(() => {
      const hadExternalWrite = externalWritePending;
      externalWritePending = false;
      return hadExternalWrite;
    });
    mockRunMove.mockImplementation(async () => {
      if (externalWritePending) throw new MockConcurrencyError('state.json was modified by another process');
      return { url: PR_URL, target: 'shelved', description: 'Shelved' };
    });

    const first = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });
    expect(first.isError).toBeFalsy();

    // External CLI write lands between the two MCP calls. Pre-fix, every
    // mutation from here on failed with ConcurrencyError until restart.
    externalWritePending = true;

    const second = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });
    expect(second.isError).toBeFalsy();
    // The pre-body reload absorbed the write — no conflict, no retry needed.
    expect(mockRunMove).toHaveBeenCalledTimes(2);
  });

  it('a conflict during the body reloads and retries once, producing a clean success', async () => {
    mockRunMove
      .mockRejectedValueOnce(new MockConcurrencyError('state.json was modified by another process'))
      .mockResolvedValueOnce({ url: PR_URL, target: 'shelved', description: 'Shelved' });

    const result = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(payload.description).toBe('Shelved');
    expect(payload.gistInitWarning).toBeUndefined();
    expect(mockRunMove).toHaveBeenCalledTimes(2);
    // Reload ran before the first attempt AND again before the retry.
    expect(mockStateManager.reloadIfChanged).toHaveBeenCalledTimes(2);
  });

  it('a second consecutive conflict surfaces as the normal error result', async () => {
    mockRunMove.mockRejectedValue(new MockConcurrencyError('sustained contention'));

    const result = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('sustained contention');
    // Exactly one retry — no retry loop.
    expect(mockRunMove).toHaveBeenCalledTimes(2);
  });

  it('non-concurrency errors are not retried', async () => {
    mockRunMove.mockRejectedValueOnce(new Error('GitHub API rate limit'));

    const result = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toContain('GitHub API rate limit');
    expect(mockRunMove).toHaveBeenCalledTimes(1);
  });

  it('read-only tools reload before serving — stale reads were part of #1439', async () => {
    mockRunStatus.mockResolvedValueOnce({ ok: true });

    await client.callTool({ name: 'status', arguments: {} });

    expect(mockStateManager.reloadIfChanged).toHaveBeenCalledTimes(1);
    expect(mockStateManager.reloadIfChanged.mock.invocationCallOrder[0]).toBeLessThan(
      mockRunStatus.mock.invocationCallOrder[0],
    );
  });

  it('resource reads reload state too', async () => {
    mockRunStatus.mockResolvedValueOnce({ ok: true });

    const result = await client.readResource({ uri: 'oss://status' });

    expect(result.contents).toHaveLength(1);
    expect(mockStateManager.reloadIfChanged).toHaveBeenCalledTimes(1);
  });

  it('gist mode refreshes (throttled inside GistStateStore) instead of reading the local file', async () => {
    mockEnsureGistPersistence.mockResolvedValue('gist');
    mockStateManager.isGistMode.mockReturnValue(true);
    mockRunStatus.mockResolvedValueOnce({ ok: true });

    const result = await client.callTool({ name: 'status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(mockStateManager.refreshFromGist).toHaveBeenCalledTimes(1);
    expect(mockStateManager.reloadIfChanged).not.toHaveBeenCalled();
  });

  it('GistConcurrencyError is retried once like ConcurrencyError', async () => {
    mockEnsureGistPersistence.mockResolvedValue('gist');
    mockStateManager.isGistMode.mockReturnValue(true);
    mockRunMove
      .mockRejectedValueOnce(new MockGistConcurrencyError('Gist was modified concurrently'))
      .mockResolvedValueOnce({ url: PR_URL, target: 'shelved', description: 'Shelved' });

    const result = await client.callTool({ name: 'move', arguments: { prUrl: PR_URL, target: 'shelved' } });

    expect(result.isError).toBeFalsy();
    expect(mockRunMove).toHaveBeenCalledTimes(2);
    expect(mockStateManager.refreshFromGist).toHaveBeenCalledTimes(2);
  });

  it('a reload failure never fails the call — degraded read serves cached state', async () => {
    mockStateManager.reloadIfChanged.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });
    mockRunStatus.mockResolvedValueOnce({ ok: true });

    const result = await client.callTool({ name: 'status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(JSON.parse((result.content as Array<{ text: string }>)[0].text).ok).toBe(true);
  });
});

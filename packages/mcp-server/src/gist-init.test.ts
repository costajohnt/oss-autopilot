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

const { mockGetGitHubTokenAsync, mockEnsureGistPersistence, mockRunStatus, MockConfigurationError } = vi.hoisted(() => {
  // Stand-ins for the core error classes (the whole module is mocked, so
  // tools.ts's instanceof checks run against THESE classes).
  class MockConfigurationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'ConfigurationError';
    }
  }
  return {
    mockGetGitHubTokenAsync: vi.fn(),
    mockEnsureGistPersistence: vi.fn(),
    mockRunStatus: vi.fn(),
    MockConfigurationError,
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
    // Per-call state reload (#1439) runs before every tool body.
    isGistMode: vi.fn().mockReturnValue(false),
    reloadIfChanged: vi.fn().mockReturnValue(false),
    refreshFromGist: vi.fn().mockResolvedValue(false),
  }),
  getGitHubTokenAsync: mockGetGitHubTokenAsync,
  ensureGistPersistence: mockEnsureGistPersistence,
  getSetupKeys: () => ['username'],
  getConfigKeys: () => ['username'],
  ConfigurationError: MockConfigurationError,
  ConcurrencyError: class ConcurrencyError extends Error {},
  GistConcurrencyError: class GistConcurrencyError extends Error {},
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
    mockEnsureGistPersistence.mockReset().mockResolvedValue('gist');
    mockRunStatus.mockReset().mockResolvedValue({ ok: true });
    client = await freshClient();
  });

  afterEach(async () => {
    await client.close();
  });

  it('a hard init rejection surfaces as a tool error and the next call retries init', async () => {
    // Reachable rejection mode: ensureGistPersistence CAN reject (e.g.
    // GistPermissionError propagates). The previous version of this test
    // pinned a getGitHubTokenAsync rejection, which the real function can
    // never produce — it catches everything and resolves null (#1415).
    mockEnsureGistPersistence.mockRejectedValueOnce(new Error('Gist scope missing'));

    const first = await client.callTool({ name: 'status', arguments: {} });
    expect(first.isError).toBe(true);

    const second = await client.callTool({ name: 'status', arguments: {} });
    expect(second.isError).toBeFalsy();
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
    expect(mockEnsureGistPersistence).toHaveBeenCalledWith('test-token');
  });

  it('a DEGRADED resolution succeeds with a warning and the next call retries init (#1415)', async () => {
    // The real transient mode: getStateManagerAsync warn-and-falls-back, so
    // ensureGistPersistence RESOLVES 'degraded' instead of rejecting. The
    // tool must still work (warn-and-proceed), the degradation must be
    // visible in the response, and init must NOT be memoized as success.
    mockEnsureGistPersistence.mockResolvedValueOnce('degraded');

    const first = await client.callTool({ name: 'status', arguments: {} });
    expect(first.isError).toBeFalsy();
    const firstPayload = JSON.parse((first.content as Array<{ text: string }>)[0].text);
    expect(firstPayload.gistInitWarning).toMatch(/LOCAL-ONLY/);
    expect(firstPayload.ok).toBe(true);

    // Recovery: the next call re-runs init end to end, the warning clears,
    // and a ONE-SHOT notice flags that degraded-window writes were not
    // merged into the Gist (#1431) — instead of presenting a pristine run.
    const second = await client.callTool({ name: 'status', arguments: {} });
    expect(second.isError).toBeFalsy();
    const secondPayload = JSON.parse((second.content as Array<{ text: string }>)[0].text);
    expect(secondPayload.gistInitWarning).toBeUndefined();
    expect(secondPayload.gistRecoveryNotice).toMatch(/recovered/i);
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);

    // One-shot: the call after recovery is clean.
    const third = await client.callTool({ name: 'status', arguments: {} });
    const thirdPayload = JSON.parse((third.content as Array<{ text: string }>)[0].text);
    expect(thirdPayload.gistRecoveryNotice).toBeUndefined();
  });

  it.each([
    ['config', {}],
    ['setup', {}],
    ['init', { username: 'testuser' }],
    ['state-unlink', {}],
  ] as const)(
    'persistence-affecting tool %s resets the init memo so a mid-session flip takes effect (#1431)',
    async (toolName, toolArgs) => {
      // First call memoizes a local-mode resolution.
      mockEnsureGistPersistence.mockResolvedValueOnce('local-mode');
      await client.callTool({ name: 'status', arguments: {} });
      expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

      // The flip rides the memo itself, but resets it afterwards.
      const flip = await client.callTool({ name: toolName, arguments: toolArgs as Record<string, unknown> });
      expect(flip.isError).toBeFalsy();
      expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

      // Next tool call re-runs init end to end and honors the new mode.
      await client.callTool({ name: 'status', arguments: {} });
      expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
    },
  );

  it('the memo resets even when the persistence-affecting tool FAILS (partial setup apply)', async () => {
    // runSetup applies earlier --set pairs in memory before a later invalid
    // value throws — the memo must reset either way.
    mockEnsureGistPersistence.mockResolvedValueOnce('local-mode');
    await client.callTool({ name: 'status', arguments: {} });

    const { runSetup } = await import('@oss-autopilot/core/commands');
    vi.mocked(runSetup).mockRejectedValueOnce(new Error('Invalid value for minStars'));
    const failed = await client.callTool({ name: 'setup', arguments: {} });
    expect(failed.isError).toBe(true);

    await client.callTool({ name: 'status', arguments: {} });
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
  });

  it('resource reads run gist init, and proceed on degraded AND hard init errors (#1431)', async () => {
    // Degraded: read succeeds, init observed.
    mockEnsureGistPersistence.mockResolvedValueOnce('degraded');
    const degradedRead = await client.readResource({ uri: 'oss://status' });
    expect(degradedRead.contents).toHaveLength(1);
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);

    // Hard error: resources are diagnostic surfaces — the read still serves
    // local state instead of bricking (unlike the tool path, which errors).
    mockEnsureGistPersistence.mockRejectedValueOnce(new Error('Gist scope missing'));
    const hardErrorRead = await client.readResource({ uri: 'oss://status' });
    expect(hardErrorRead.contents).toHaveLength(1);
  });

  it('a recovery notice is dropped (not leaked) when the recovering response has no object payload', async () => {
    mockEnsureGistPersistence.mockResolvedValueOnce('degraded');
    await client.callTool({ name: 'status', arguments: {} });

    // Recovery lands on a call whose tool returns undefined: notice dropped.
    mockRunStatus.mockResolvedValueOnce(undefined);
    const recovering = await client.callTool({ name: 'status', arguments: {} });
    expect((recovering.content as Array<{ text: string }>)[0].text).toBe('{}');

    // It must NOT resurface on the next unrelated response.
    const after = await client.callTool({ name: 'status', arguments: {} });
    const payload = JSON.parse((after.content as Array<{ text: string }>)[0].text);
    expect(payload.gistRecoveryNotice).toBeUndefined();
  });

  it('a transient token-fetch failure (null token in gist mode) warns and retries (#1415)', async () => {
    // getGitHubTokenAsync resolves null on a transient gh timeout (it no
    // longer latches) — ensureGistPersistence reports 'no-token'.
    mockGetGitHubTokenAsync.mockResolvedValueOnce(null);
    mockEnsureGistPersistence.mockResolvedValueOnce('no-token');

    const first = await client.callTool({ name: 'status', arguments: {} });
    expect(first.isError).toBeFalsy();
    const firstPayload = JSON.parse((first.content as Array<{ text: string }>)[0].text);
    expect(firstPayload.gistInitWarning).toMatch(/no GitHub token/);

    // Token fetch recovers on the next call; init re-runs with the token.
    const second = await client.callTool({ name: 'status', arguments: {} });
    expect(second.isError).toBeFalsy();
    const secondPayload = JSON.parse((second.content as Array<{ text: string }>)[0].text);
    expect(secondPayload.gistInitWarning).toBeUndefined();
    expect(mockEnsureGistPersistence).toHaveBeenLastCalledWith('test-token');
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
  });

  it('concurrent calls during a degraded init both carry the warning, then one retry', async () => {
    let release!: (status: string) => void;
    mockEnsureGistPersistence.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );

    const a = client.callTool({ name: 'status', arguments: {} });
    const b = client.callTool({ name: 'status', arguments: {} });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release('degraded');

    const [resultA, resultB] = await Promise.all([a, b]);
    for (const result of [resultA, resultB]) {
      const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
      expect(payload.gistInitWarning).toMatch(/LOCAL-ONLY/);
    }
    // Both shared one init; the NEXT call re-runs it (memo cleared once).
    await client.callTool({ name: 'status', arguments: {} });
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
  });

  it('local-mode resolution memoizes like success: no per-call re-init for local users', async () => {
    mockEnsureGistPersistence.mockResolvedValue('local-mode');

    const first = await client.callTool({ name: 'status', arguments: {} });
    expect(JSON.parse((first.content as Array<{ text: string }>)[0].text).gistInitWarning).toBeUndefined();
    await client.callTool({ name: 'status', arguments: {} });
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
  });

  it('successful init is memoized: later calls do not re-run it', async () => {
    await client.callTool({ name: 'status', arguments: {} });
    await client.callTool({ name: 'status', arguments: {} });

    expect(mockGetGitHubTokenAsync).toHaveBeenCalledTimes(1);
    expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(1);
  });

  describe('repair tools survive hard gist-init errors (#1441)', () => {
    // Hard ConfigurationError (GistPermissionError/GistCorruptError) used to
    // reject in wrapTool BEFORE the body ran — bricking config/init/setup/
    // state-unlink, the very tools that exist to repair a broken gist setup.
    // Mirrors the CLI's bootstrapGistBestEffort carve-out.
    it.each([
      ['config', {}, 'runConfig'],
      ['setup', {}, 'runSetup'],
      ['init', { username: 'testuser' }, 'runInit'],
      ['state-unlink', {}, 'runStateUnlink'],
    ] as const)(
      'repair tool %s runs locally with a gistInitWarning when init throws ConfigurationError',
      async (toolName, toolArgs, commandName) => {
        const commands = await import('@oss-autopilot/core/commands');
        const command = vi.mocked(commands[commandName] as (args?: unknown) => Promise<unknown>);
        command.mockClear();
        command.mockResolvedValueOnce({ ok: true });
        mockEnsureGistPersistence.mockRejectedValueOnce(new MockConfigurationError('Gist token lacks the gist scope'));

        const result = await client.callTool({ name: toolName, arguments: toolArgs as Record<string, unknown> });

        expect(result.isError).toBeFalsy();
        expect(command).toHaveBeenCalled();
        const payload = JSON.parse((result.content as Array<{ text: string }>)[0].text);
        expect(payload.ok).toBe(true);
        expect(payload.gistInitWarning).toMatch(/LOCAL-ONLY/);
        expect(payload.gistInitWarning).toContain('Gist token lacks the gist scope');

        // The hard rejection cleared the init memo — the next call retries
        // init end to end, so an external fix (or the repair itself) heals
        // the process without a restart.
        await client.callTool({ name: 'status', arguments: {} });
        expect(mockEnsureGistPersistence).toHaveBeenCalledTimes(2);
      },
    );

    it('a non-repair tool still fails hard on the same ConfigurationError (#1202)', async () => {
      mockEnsureGistPersistence.mockRejectedValueOnce(new MockConfigurationError('Gist token lacks the gist scope'));

      const result = await client.callTool({ name: 'status', arguments: {} });

      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toContain('Gist token lacks the gist scope');
      expect(mockRunStatus).not.toHaveBeenCalled();
    });

    it('a repair tool still fails hard on a NON-configuration init error', async () => {
      const commands = await import('@oss-autopilot/core/commands');
      vi.mocked(commands.runConfig).mockClear();
      mockEnsureGistPersistence.mockRejectedValueOnce(new Error('unexpected init explosion'));

      const result = await client.callTool({ name: 'config', arguments: {} });

      expect(result.isError).toBe(true);
      expect(vi.mocked(commands.runConfig)).not.toHaveBeenCalled();
    });
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

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Mock core dependencies (required by server.ts -> tools.ts/resources.ts/prompts.ts)
vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: vi.fn(),
  runStatus: vi.fn(),
  runStrategy: vi.fn(),
  runSearch: vi.fn(),
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

// Mock StdioServerTransport — must use function() not arrow to support `new`
// Needs start/close methods since McpServer.connect() calls transport.start()
vi.mock('@modelcontextprotocol/sdk/server/stdio.js', () => ({
  StdioServerTransport: vi.fn().mockImplementation(function () {
    return { start: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) };
  }),
}));

// Mock HTTP server
const mockListen = vi.fn((_port: number, _host: string, cb: () => void) => cb());
const mockClose = vi.fn();
const mockHttpServer = { listen: mockListen, close: mockClose };

vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>();
  return {
    ...original,
    createServer: vi.fn((_handler: unknown) => mockHttpServer),
  };
});

// Mock StreamableHTTPServerTransport
const mockHandleRequest = vi.fn().mockResolvedValue(undefined);
vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function () {
    return {
      handleRequest: mockHandleRequest,
      start: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
  }),
}));

// Mock auth.js so tests don't touch the real ~/.oss-autopilot/mcp.token
// (#1028). Tests pass the stub token through the Authorization header.
// `vi.hoisted` is required because vi.mock factories are hoisted above the
// file; a plain `const` outside the factory would be `undefined` at mock
// resolution time.
const { TEST_TOKEN } = vi.hoisted(() => ({
  TEST_TOKEN: 'test-bearer-token-0123456789abcdef0123456789abcdef012345678',
}));
vi.mock('./auth.js', () => ({
  ensureHttpToken: vi.fn().mockResolvedValue({
    token: TEST_TOKEN,
    path: '/tmp/fake-mcp-token',
    freshlyGenerated: false,
  }),
  validateBearerToken: vi.fn(
    (header: string | undefined, expected: string) => typeof header === 'string' && header === `Bearer ${expected}`,
  ),
  isValidHost: vi.fn(
    (host: string | undefined, port: number) => host === `127.0.0.1:${port}` || host === `localhost:${port}`,
  ),
}));

import { main, ENTRY_SUFFIXES } from './index.js';

// Sentinel error for mocked process.exit
class ExitError extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

describe('main() in-process', () => {
  const originalArgv = process.argv;
  let mockExit: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    process.setMaxListeners(20); // Avoid MaxListenersExceededWarning
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock process.exit to throw so execution stops
    mockExit = vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
      throw new ExitError(code ?? 0);
    }) as never);
  });

  afterEach(() => {
    process.argv = originalArgv;
    mockExit.mockRestore();
    // Clean up SIGINT/SIGTERM listeners added by main()
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  afterAll(() => {
    process.setMaxListeners(10);
  });

  describe('stdio mode', () => {
    it('starts stdio transport when no --http flag', async () => {
      process.argv = ['node', 'test'];

      await main();

      const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
      expect(StdioServerTransport).toHaveBeenCalled();
    });
  });

  describe('HTTP mode - port parsing', () => {
    it('uses default port 3001 when --http and no --port', async () => {
      process.argv = ['node', 'test', '--http'];

      await main();

      expect(mockListen).toHaveBeenCalledWith(3001, '127.0.0.1', expect.any(Function));
    });

    it('parses --port=N form', async () => {
      process.argv = ['node', 'test', '--http', '--port=8080'];

      await main();

      expect(mockListen).toHaveBeenCalledWith(8080, '127.0.0.1', expect.any(Function));
    });

    it('parses --port N (space form)', async () => {
      process.argv = ['node', 'test', '--http', '--port', '9090'];

      await main();

      expect(mockListen).toHaveBeenCalledWith(9090, '127.0.0.1', expect.any(Function));
    });
  });

  describe('HTTP mode - port validation', () => {
    it('exits with error for port 0', async () => {
      process.argv = ['node', 'test', '--http', '--port=0'];

      await expect(main()).rejects.toThrow(ExitError);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('exits with error for port > 65535', async () => {
      process.argv = ['node', 'test', '--http', '--port=70000'];

      await expect(main()).rejects.toThrow(ExitError);
      expect(mockExit).toHaveBeenCalledWith(1);
    });

    it('exits with error for NaN port', async () => {
      process.argv = ['node', 'test', '--http', '--port=abc'];

      await expect(main()).rejects.toThrow(ExitError);
      expect(mockExit).toHaveBeenCalledWith(1);
    });
  });

  describe('HTTP mode - request handling', () => {
    // Structural stand-in for http.IncomingMessage; the handler only reads
    // url, method, and headers.
    type FakeRequest = { url?: string; method?: string; headers?: Record<string, string | undefined> };

    async function setupHttpHandler(): Promise<(req: FakeRequest, res: Record<string, unknown>) => Promise<void>> {
      process.argv = ['node', 'test', '--http', '--port=3001'];

      const { createServer: mockCreateServer } = await import('node:http');
      let requestHandler!: (req: FakeRequest, res: Record<string, unknown>) => Promise<void>;
      vi.mocked(mockCreateServer).mockImplementationOnce((handler: unknown) => {
        requestHandler = handler as typeof requestHandler;
        // Partial mock: main() only calls listen/close on the server.
        return mockHttpServer as unknown as ReturnType<typeof mockCreateServer>;
      });

      await main();
      return requestHandler;
    }

    // Common request fixture: every /api/ route now requires a loopback
    // Host header and a bearer token. Tests that exercise the post-auth
    // code paths use this helper; Host/Auth negative tests construct their
    // own request objects directly.
    const withAuthHeaders = (req: Partial<{ url: string; method: string }>) => ({
      url: req.url,
      method: req.method,
      headers: {
        host: '127.0.0.1:3001',
        authorization: `Bearer ${TEST_TOKEN}`,
        // POSTs now require a numeric Content-Length in range (#1028 review).
        // GETs ignore it.
        'content-length': '100',
      },
    });

    it('returns 404 for non-/mcp paths', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(withAuthHeaders({ url: '/wrong-path', method: 'POST' }), res);

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not Found');
    });

    it('returns 405 for non-POST to /mcp', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(withAuthHeaders({ url: '/mcp', method: 'GET' }), res);

      expect(res.writeHead).toHaveBeenCalledWith(405);
      expect(res.end).toHaveBeenCalledWith('Method Not Allowed');
    });

    it('processes valid POST /mcp through transport', async () => {
      const handler = await setupHttpHandler();

      const req = withAuthHeaders({ url: '/mcp', method: 'POST' });
      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(req, res);

      const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
      expect(StreamableHTTPServerTransport).toHaveBeenCalled();
      expect(mockHandleRequest).toHaveBeenCalledWith(req, res);
    });

    it('returns 500 on transport error', async () => {
      const handler = await setupHttpHandler();

      mockHandleRequest.mockRejectedValueOnce(new Error('Transport error'));

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(withAuthHeaders({ url: '/mcp', method: 'POST' }), res);

      expect(res.writeHead).toHaveBeenCalledWith(500);
      expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });

    it('skips writeHead when headers already sent on error', async () => {
      const handler = await setupHttpHandler();

      mockHandleRequest.mockRejectedValueOnce(new Error('Transport error'));

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: true };
      await handler(withAuthHeaders({ url: '/mcp', method: 'POST' }), res);

      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('rejects requests with an invalid Host header (403)', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(
        {
          url: '/mcp',
          method: 'POST',
          headers: { host: 'evil.example.com', authorization: `Bearer ${TEST_TOKEN}` },
        },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(403);
      expect(res.end).toHaveBeenCalledWith('Invalid host');
    });

    it('rejects requests with a missing Authorization header (401)', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(
        {
          url: '/mcp',
          method: 'POST',
          headers: { host: '127.0.0.1:3001', 'content-length': '100' },
        },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(
        401,
        expect.objectContaining({
          'WWW-Authenticate': expect.stringMatching(/Bearer/),
        }),
      );
      expect(res.end).toHaveBeenCalledWith('Unauthorized');
    });

    it('rejects requests whose Content-Length exceeds 1 MiB (413)', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler(
        {
          url: '/mcp',
          method: 'POST',
          headers: {
            host: '127.0.0.1:3001',
            authorization: `Bearer ${TEST_TOKEN}`,
            'content-length': String(1_048_577),
          },
        },
        res,
      );

      expect(res.writeHead).toHaveBeenCalledWith(413);
      expect(res.end).toHaveBeenCalledWith('Payload Too Large');
    });
  });
});

describe('ENTRY_SUFFIXES', () => {
  it('contains expected paths for isMain detection', () => {
    expect(ENTRY_SUFFIXES).toContain('/mcp-server/src/index.ts');
    expect(ENTRY_SUFFIXES).toContain('/mcp-server/dist/index.js');
    expect(ENTRY_SUFFIXES).toContain('/mcp-server.bundle.cjs');
    expect(ENTRY_SUFFIXES).toContain('/oss-autopilot-mcp');
    expect(ENTRY_SUFFIXES).toHaveLength(4);
  });
});

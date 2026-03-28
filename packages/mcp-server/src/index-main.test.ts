import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';

// Mock core dependencies (required by server.ts -> tools.ts/resources.ts/prompts.ts)
vi.mock('@oss-autopilot/core/commands', () => ({
  runDaily: vi.fn(),
  runStatus: vi.fn(),
  runSearch: vi.fn(),
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
  runMove: vi.fn(),
}));

vi.mock('@oss-autopilot/core', () => ({
  errorMessage: (e: unknown) => (e instanceof Error ? e.message : String(e)),
  getStateManager: vi.fn().mockReturnValue({
    getState: vi.fn().mockReturnValue({
      lastDigest: { openPRs: [], shelvedPRs: [] },
    }),
  }),
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
    async function setupHttpHandler(): Promise<
      (req: { url?: string; method?: string }, res: Record<string, unknown>) => Promise<void>
    > {
      process.argv = ['node', 'test', '--http', '--port=3001'];

      const { createServer: mockCreateServer } = await import('node:http');
      let requestHandler!: (req: { url?: string; method?: string }, res: Record<string, unknown>) => Promise<void>;
      vi.mocked(mockCreateServer).mockImplementationOnce((handler: unknown) => {
        requestHandler = handler as typeof requestHandler;
        return mockHttpServer as ReturnType<typeof mockCreateServer>;
      });

      await main();
      return requestHandler;
    }

    it('returns 404 for non-/mcp paths', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler({ url: '/wrong-path', method: 'POST' }, res);

      expect(res.writeHead).toHaveBeenCalledWith(404);
      expect(res.end).toHaveBeenCalledWith('Not Found');
    });

    it('returns 405 for non-POST to /mcp', async () => {
      const handler = await setupHttpHandler();

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: false };
      await handler({ url: '/mcp', method: 'GET' }, res);

      expect(res.writeHead).toHaveBeenCalledWith(405);
      expect(res.end).toHaveBeenCalledWith('Method Not Allowed');
    });

    it('processes valid POST /mcp through transport', async () => {
      const handler = await setupHttpHandler();

      const req = { url: '/mcp', method: 'POST' };
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
      await handler({ url: '/mcp', method: 'POST' }, res);

      expect(res.writeHead).toHaveBeenCalledWith(500);
      expect(res.end).toHaveBeenCalledWith('Internal Server Error');
    });

    it('skips writeHead when headers already sent on error', async () => {
      const handler = await setupHttpHandler();

      mockHandleRequest.mockRejectedValueOnce(new Error('Transport error'));

      const res = { writeHead: vi.fn(), end: vi.fn(), headersSent: true };
      await handler({ url: '/mcp', method: 'POST' }, res);

      expect(res.writeHead).not.toHaveBeenCalled();
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

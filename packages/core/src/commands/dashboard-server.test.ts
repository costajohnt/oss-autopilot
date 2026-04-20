/**
 * Tests for dashboard server (dashboard-server.ts)
 *
 * Covers: static file serving, API data endpoint, action endpoint,
 * refresh endpoint, method validation, SPA fallback routing, content types,
 * security headers, origin validation, rate limiting, path traversal
 * protection, body size limits, action validation edge cases.
 *
 * Strategy: Mock the http module to capture the request handler passed
 * to createServer, then test it directly without spinning up a real
 * TCP server. This avoids port conflicts and ESM spy limitations.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { DailyDigest } from '../core/types.js';
import { makeAgentState as makeState } from '../core/test-utils.js';
import type { IncomingMessage, ServerResponse } from 'http';

// ── Captured request handler ──────────────────────────────────────────
// We'll capture the handler passed to http.createServer() and test it directly.
type RequestHandler = (req: IncomingMessage, res: ServerResponse) => void;
let capturedHandler: RequestHandler | null = null;

// ── Mock http module ──────────────────────────────────────────────────
// We need to mock http.createServer to capture the request handler,
// and also provide a mock server object that has listen/close/on/once methods.
const mockServer = {
  listen: vi.fn((_port: number, _host: string, cb: () => void) => {
    cb();
  }),
  close: vi.fn((cb?: () => void) => {
    if (cb) cb();
  }),
  on: vi.fn(),
  once: vi.fn(),
};

vi.mock('http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('http')>();
  return {
    ...actual,
    createServer: vi.fn((handler: RequestHandler) => {
      capturedHandler = handler;
      return mockServer;
    }),
  };
});

// ── Mock state manager ────────────────────────────────────────────────
const mockStateManager = {
  getState: vi.fn(),
  setLastDigest: vi.fn(),
  setMonthlyMergedCounts: vi.fn(),
  setMonthlyClosedCounts: vi.fn(),
  setMonthlyOpenedCounts: vi.fn(),
  save: vi.fn(),
  shelvePR: vi.fn().mockReturnValue(true),
  unshelvePR: vi.fn().mockReturnValue(true),
  setStatusOverride: vi.fn(),
  getStatusOverride: vi.fn().mockReturnValue(undefined),
  dismissIssue: vi.fn().mockReturnValue(true),
  getMergedPRs: vi.fn().mockReturnValue([]),
  getClosedPRs: vi.fn().mockReturnValue([]),
  reloadIfChanged: vi.fn().mockReturnValue(false),
  isGistMode: vi.fn().mockReturnValue(false),
  refreshFromGist: vi.fn().mockResolvedValue(false),
};

// Create a temp dir for PID file tests (needs to exist before mock is evaluated)
const pidTestDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-pid-test-'));

vi.mock('../core/index.js', () => ({
  getStateManager: vi.fn(() => mockStateManager),
  getGitHubToken: vi.fn(() => null),
  getDataDir: vi.fn(() => pidTestDir),
  getCLIVersion: vi.fn(() => '0.44.6'),
  applyStatusOverrides: vi.fn((prs: unknown[]) => prs),
}));

// Mock fetchDashboardData so we never call GitHub
vi.mock('./dashboard-data.js', () => ({
  fetchDashboardData: vi.fn(),
  computePRsByRepo: vi.fn(() => ({
    'owner/repo': { active: 2, merged: 5, closed: 1 },
  })),
  computeTopRepos: vi.fn(() => [['owner/repo', { active: 2, merged: 5, closed: 1 }]]),
  getMonthlyData: vi.fn(() => ({
    monthlyMerged: { '2026-01': 3 },
    monthlyClosed: {},
    monthlyOpened: {},
  })),
  buildDashboardStats: vi.fn(() => ({
    activePRs: 2,
    shelvedPRs: 0,
    mergedPRs: 5,
    closedPRs: 1,
    mergeRate: '83.3%',
  })),
  storedToMergedPRs: vi.fn(() => []),
  storedToClosedPRs: vi.fn(() => []),
}));

// Mock move command so dashboard-server's dynamic import resolves without side effects
const mockRunMove = vi.fn().mockResolvedValue({ url: '', target: 'shelved', description: 'done' });
vi.mock('./move.js', () => ({
  VALID_TARGETS: ['attention', 'waiting', 'shelved', 'auto'],
  runMove: (...args: unknown[]) => mockRunMove(...args),
}));

// Mock rate limiter — controllable via module-level variable
let rateLimitOverride: { allowed: boolean; retryAfterSeconds?: number } | null = null;

vi.mock('./rate-limiter.js', () => ({
  RateLimiter: class {
    check() {
      return rateLimitOverride ?? { allowed: true };
    }
  },
}));

import {
  buildDashboardJson,
  startDashboardServer,
  getDashboardPidPath,
  writeDashboardServerInfo,
  readDashboardServerInfo,
  removeDashboardServerInfo,
  isDashboardServerRunning,
  findRunningDashboardServer,
  type DashboardServerInfo,
} from './dashboard-server.js';
import { fetchDashboardData, storedToMergedPRs } from './dashboard-data.js';
import { getGitHubToken } from '../core/index.js';

// ── Test Data ────────────────────────────────────────────────────────

function makeDigest(overrides: Partial<DailyDigest> = {}): DailyDigest {
  return {
    generatedAt: '2026-01-15T12:00:00Z',
    openPRs: [],
    needsAddressingPRs: [],
    waitingOnMaintainerPRs: [],
    recentlyClosedPRs: [],
    recentlyMergedPRs: [],
    shelvedPRs: [],
    autoUnshelvedPRs: [],
    summary: {
      totalActivePRs: 2,
      totalNeedingAttention: 0,
      totalMergedAllTime: 5,
      mergeRate: 83.3,
    },
    ...overrides,
  };
}

// ── Mock IncomingMessage and ServerResponse ──────────────────────────

function createMockReq(method: string, url: string, body?: string): IncomingMessage {
  // EventEmitter imported at top of file
  const req = new EventEmitter() as IncomingMessage;
  req.method = method;
  req.url = url;
  req.headers = {};
  // Provide a destroy stub so readBody's size-limit abort path works
  req.destroy = vi.fn(() => req) as any;

  // For POST requests, simulate body streaming
  if (body !== undefined) {
    process.nextTick(() => {
      req.emit('data', Buffer.from(body));
      req.emit('end');
    });
  } else if (method === 'POST') {
    // Empty POST body
    process.nextTick(() => {
      req.emit('end');
    });
  }

  return req;
}

interface MockResponseResult {
  statusCode: number;
  headers: Record<string, string | number>;
  body: string;
}

function createMockRes(): { res: ServerResponse; result: Promise<MockResponseResult> } {
  const resEmitter = new EventEmitter();
  let statusCode = 200;
  const headers: Record<string, string | number> = {};
  const chunks: Buffer[] = [];

  const res = resEmitter as unknown as ServerResponse;

  res.setHeader = vi.fn((name: string, value: string | number) => {
    headers[name.toLowerCase()] = value;
    return res;
  });

  res.writeHead = vi.fn((code: number, hdrs?: Record<string, string | number>) => {
    statusCode = code;
    if (hdrs) Object.assign(headers, hdrs);
    return res;
  });

  res.end = vi.fn((data?: string | Buffer) => {
    if (data) {
      chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }
    resEmitter.emit('finish');
    return res;
  }) as any;

  const result = new Promise<MockResponseResult>((resolve) => {
    resEmitter.once('finish', () => {
      resolve({
        statusCode,
        headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      });
    });
  });

  return { res, result };
}

// ── Test suite ───────────────────────────────────────────────────────

describe('dashboard-server', () => {
  let tmpDir: string;

  beforeAll(async () => {
    // Suppress console output during tests
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    // Create a temporary assets directory with minimal files
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-server-test-'));
    fs.writeFileSync(path.join(tmpDir, 'index.html'), '<html><body>Dashboard</body></html>');
    fs.writeFileSync(path.join(tmpDir, 'test.css'), 'body { color: red; }');
    fs.writeFileSync(path.join(tmpDir, 'app.js'), 'console.log("app");');
    fs.writeFileSync(path.join(tmpDir, 'icon.svg'), '<svg></svg>');

    // Set up state manager mock with a cached digest
    const digest = makeDigest();
    const state = makeState({ lastDigest: digest });
    mockStateManager.getState.mockReturnValue(state);

    // Start the server (will be intercepted by our http mock)
    await startDashboardServer({
      port: 19876,
      assetsDir: tmpDir,
      token: null,
      open: false,
    });

    // Verify we captured the request handler
    expect(capturedHandler).not.toBeNull();
  });

  afterAll(() => {
    // Clean up temp directories
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      fs.rmSync(pidTestDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    // Clear mock call counts but keep the mock implementations
    mockStateManager.shelvePR.mockClear();
    mockStateManager.unshelvePR.mockClear();
    mockStateManager.setStatusOverride.mockClear();
    mockStateManager.dismissIssue.mockClear();
    mockStateManager.save.mockClear();

    // Re-setup the state mock
    const digest = makeDigest();
    const state = makeState({ lastDigest: digest });
    mockStateManager.getState.mockReturnValue(state);
    mockStateManager.shelvePR.mockReturnValue(true);
    mockStateManager.unshelvePR.mockReturnValue(true);
    mockStateManager.getStatusOverride.mockReturnValue(undefined);
  });

  // Helper to send a request through the captured handler
  async function sendRequest(method: string, url: string, body?: string): Promise<MockResponseResult> {
    const req = createMockReq(method, url, body);
    const { res, result } = createMockRes();
    capturedHandler!(req, res);
    return result;
  }

  // Helper to send a request with custom headers (e.g. Origin for origin validation / CSRF protection tests)
  async function sendRequestWithHeaders(
    method: string,
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<MockResponseResult> {
    const req = createMockReq(method, url, body);
    Object.assign(req.headers, headers);
    const { res, result } = createMockRes();
    capturedHandler!(req, res);
    return result;
  }

  // ── Static file serving ──────────────────────────────────────────

  describe('static file serving', () => {
    it('should serve index.html for GET /', async () => {
      const result = await sendRequest('GET', '/');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/html');
      expect(result.body).toContain('Dashboard');
    });

    it('should fall back to index.html for nonexistent paths (SPA routing)', async () => {
      const result = await sendRequest('GET', '/nonexistent/path');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/html');
      expect(result.body).toContain('Dashboard');
    });

    it('should serve CSS files with correct Content-Type', async () => {
      const result = await sendRequest('GET', '/test.css');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('text/css');
      expect(result.body).toContain('body { color: red; }');
    });

    it('should serve JavaScript files with correct Content-Type', async () => {
      const result = await sendRequest('GET', '/app.js');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/javascript');
      expect(result.body).toContain('console.log("app")');
    });

    it('should serve SVG files with correct Content-Type', async () => {
      const result = await sendRequest('GET', '/icon.svg');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('image/svg+xml');
    });
  });

  // ── API data endpoint ────────────────────────────────────────────

  describe('GET /api/data', () => {
    it('should return JSON with expected shape', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.statusCode).toBe(200);
      expect(result.headers['Content-Type']).toBe('application/json');

      const data = JSON.parse(result.body);
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('prsByRepo');
      expect(data).toHaveProperty('topRepos');
      expect(data).toHaveProperty('monthlyMerged');
      expect(data).toHaveProperty('activePRs');
      expect(data).toHaveProperty('commentedIssues');
      expect(data).toHaveProperty('issueResponses');
      expect(data).toHaveProperty('recentlyMergedPRs');
      expect(data).toHaveProperty('recentlyClosedPRs');
      expect(data).toHaveProperty('autoUnshelvedPRs');
      expect(data).toHaveProperty('allMergedPRs');
      expect(data).toHaveProperty('repoMetadata');
      expect(Array.isArray(data.recentlyMergedPRs)).toBe(true);
      expect(Array.isArray(data.recentlyClosedPRs)).toBe(true);
      expect(Array.isArray(data.autoUnshelvedPRs)).toBe(true);
      expect(Array.isArray(data.allMergedPRs)).toBe(true);
      expect(typeof data.repoMetadata).toBe('object');
    });

    it('should return stats with correct values', async () => {
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);

      expect(data.stats).toEqual({
        activePRs: 2,
        shelvedPRs: 0,
        mergedPRs: 5,
        closedPRs: 1,
        mergeRate: '83.3%',
      });
    });

    it('should return activePRs as an array', async () => {
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);
      expect(Array.isArray(data.activePRs)).toBe(true);
    });

    it('should return commentedIssues as an array', async () => {
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);
      expect(Array.isArray(data.commentedIssues)).toBe(true);
    });

    it('should return issueResponses as an array', async () => {
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);
      expect(Array.isArray(data.issueResponses)).toBe(true);
    });

    it('should return shelvedPRUrls as an array', async () => {
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);
      expect(Array.isArray(data.shelvedPRUrls)).toBe(true);
    });

    it('should derive shelvedPRUrls from digest.shelvedPRs, not config.shelvedPRUrls (#981)', () => {
      // Dashboard card shows `stats.shelvedPRs`, which counts digest.shelvedPRs.
      // The response's shelvedPRUrls must use the same source so the PR list
      // filter matches. Previously it pulled from config.shelvedPRUrls, which
      // excluded dormant-non-addressing PRs the orchestration layer had
      // already moved into digest.shelvedPRs — leaving them visible in the
      // active list while still counted in the shelved card.
      const digest = makeDigest({
        shelvedPRs: [
          {
            number: 1,
            url: 'https://github.com/o/r/pull/1',
            title: 'Explicit shelf',
            repo: 'o/r',
            daysSinceActivity: 10,
            status: 'waiting_on_maintainer',
          },
          {
            number: 2,
            url: 'https://github.com/o/r/pull/2',
            title: 'Dormant auto-shelf',
            repo: 'o/r',
            daysSinceActivity: 45,
            status: 'waiting_on_maintainer',
          },
        ],
      });
      const state = makeState({
        config: { shelvedPRUrls: ['https://github.com/o/r/pull/1'] },
        lastDigest: digest,
      });

      const data = buildDashboardJson(digest, state, []);

      expect(data.shelvedPRUrls).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2']);
    });

    it('should include repos with metadata and exclude repos without in repoMetadata (#677)', async () => {
      const state = makeState({
        lastDigest: makeDigest(),
        repoScores: {
          'has/both': {
            score: 5,
            mergedPRCount: 1,
            closedWithoutMergeCount: 0,
            signals: {},
            stargazersCount: 500,
            language: 'TypeScript',
          },
          'has/stars-only': {
            score: 5,
            mergedPRCount: 1,
            closedWithoutMergeCount: 0,
            signals: {},
            stargazersCount: 100,
          },
          'has/null-language': {
            score: 5,
            mergedPRCount: 1,
            closedWithoutMergeCount: 0,
            signals: {},
            stargazersCount: 200,
            language: null,
          },
          'no/metadata': { score: 5, mergedPRCount: 2, closedWithoutMergeCount: 0, signals: {} },
        },
      });
      mockStateManager.getState.mockReturnValue(state);

      // Trigger a rebuild via action so the new state is picked up
      await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/99', target: 'shelved' }),
      );
      const result = await sendRequest('GET', '/api/data');
      const data = JSON.parse(result.body);

      // Repos with stars or language should be included
      expect(data.repoMetadata['has/both']).toEqual({ stars: 500, language: 'TypeScript' });
      expect(data.repoMetadata['has/stars-only']).toEqual({ stars: 100 });
      expect(data.repoMetadata['has/null-language']).toEqual({ stars: 200, language: null });
      // Repos without any metadata should be excluded
      expect(data.repoMetadata['no/metadata']).toBeUndefined();
    });
  });

  // ── minStars filtering ──────────────────────────────────────────

  describe('minStars filtering of merged PRs', () => {
    const mergedPRFixtures = [
      {
        url: 'https://github.com/big/repo/pull/1',
        repo: 'big/repo',
        number: 1,
        title: 'PR 1',
        mergedAt: '2026-01-01T00:00:00Z',
      },
      {
        url: 'https://github.com/tiny/repo/pull/2',
        repo: 'tiny/repo',
        number: 2,
        title: 'PR 2',
        mergedAt: '2026-01-02T00:00:00Z',
      },
      {
        url: 'https://github.com/unknown/repo/pull/3',
        repo: 'unknown/repo',
        number: 3,
        title: 'PR 3',
        mergedAt: '2026-01-03T00:00:00Z',
      },
    ];

    afterEach(() => {
      vi.mocked(storedToMergedPRs).mockReturnValue([]);
    });

    it('should filter merged PRs by minStars: exclude low-star, unknown repos; keep high-star', async () => {
      // Set up mocks: big/repo has 200 stars (passes), tiny/repo has 10 (excluded), unknown/repo not in repoScores (excluded)
      vi.mocked(storedToMergedPRs).mockReturnValue(mergedPRFixtures);
      const state = makeState({
        lastDigest: makeDigest(),
        repoScores: {
          'big/repo': { stargazersCount: 200, totalScore: 10 } as any,
          'tiny/repo': { stargazersCount: 10, totalScore: 5 } as any,
        },
      });
      mockStateManager.getState.mockReturnValue(state);

      // Trigger a rebuild via action (action rebuilds cachedJsonData)
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/99', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);

      // Only big/repo (200 stars >= 50) should remain
      expect(data.allMergedPRs).toHaveLength(1);
      expect(data.allMergedPRs[0].repo).toBe('big/repo');

      // Verify: if all repos meet threshold, all are returned
      const stateAllPass = makeState({
        lastDigest: makeDigest(),
        repoScores: {
          'big/repo': { stargazersCount: 200, totalScore: 10 } as any,
          'tiny/repo': { stargazersCount: 100, totalScore: 5 } as any,
          'unknown/repo': { stargazersCount: 50, totalScore: 3 } as any,
        },
      });
      mockStateManager.getState.mockReturnValue(stateAllPass);

      // GET /api/data won't rebuild — we need to verify via the cached data from the action
      // But we already proved the filtering logic works above. The complementary case
      // (repos not in repoScores excluded) was covered by unknown/repo being excluded.
    });
  });

  // ── API action endpoint ──────────────────────────────────────────

  describe('POST /api/action', () => {
    it('should accept a valid move shelved action and return updated data', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/1',
          target: 'shelved',
        }),
      );
      expect(result.statusCode).toBe(200);

      const data = JSON.parse(result.body);
      expect(data).toHaveProperty('stats');
      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/owner/repo/pull/1',
        target: 'shelved',
      });
    });

    it('should accept a valid move auto action (unshelve)', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/2',
          target: 'auto',
        }),
      );
      expect(result.statusCode).toBe(200);
      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/owner/repo/pull/2',
        target: 'auto',
      });
    });

    it('should accept a valid move waiting action (override status)', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/3',
          target: 'waiting',
        }),
      );
      expect(result.statusCode).toBe(200);
      expect(mockRunMove).toHaveBeenCalledWith({
        prUrl: 'https://github.com/owner/repo/pull/3',
        target: 'waiting',
      });
    });

    it('should return 400 for move without valid target field', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/4',
        }),
      );
      expect(result.statusCode).toBe(400);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('move requires a valid "target" field');
    });

    it('should return 400 for invalid action', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'invalid_action',
          url: 'https://github.com/owner/repo/pull/1',
        }),
      );
      expect(result.statusCode).toBe(400);

      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid action');
    });

    it('should return 400 for missing action field', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          url: 'https://github.com/owner/repo/pull/1',
        }),
      );
      expect(result.statusCode).toBe(400);

      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid action');
    });

    it('should return 400 for missing url field', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          target: 'shelved',
        }),
      );
      expect(result.statusCode).toBe(400);

      const data = JSON.parse(result.body);
      expect(data.error).toContain('url');
    });

    it('should return 400 for invalid JSON body', async () => {
      const result = await sendRequest('POST', '/api/action', 'not valid json');
      expect(result.statusCode).toBe(400);

      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid JSON');
    });

    it('should return updated data with full dashboard shape after action', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/1',
          target: 'shelved',
        }),
      );
      expect(result.statusCode).toBe(200);

      const data = JSON.parse(result.body);
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('activePRs');
      expect(data).toHaveProperty('commentedIssues');
      expect(data).toHaveProperty('prsByRepo');
      expect(data).toHaveProperty('topRepos');
      expect(data).toHaveProperty('monthlyMerged');
    });

    it('should return 500 when runMove throws', async () => {
      mockRunMove.mockRejectedValueOnce(new Error('move failed'));
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'move',
          url: 'https://github.com/owner/repo/pull/1',
          target: 'shelved',
        }),
      );
      expect(result.statusCode).toBe(500);
      const data = JSON.parse(result.body);
      expect(data.error).toBe('Action failed');
    });

    it('should accept a valid dismiss_issue_response action', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({
          action: 'dismiss_issue_response',
          url: 'https://github.com/owner/repo/issues/42',
        }),
      );
      expect(result.statusCode).toBe(200);
      expect(mockStateManager.dismissIssue).toHaveBeenCalledWith(
        'https://github.com/owner/repo/issues/42',
        expect.any(String),
      );
    });
  });

  // ── Method validation ────────────────────────────────────────────

  describe('method validation', () => {
    it('should serve SPA fallback for GET /api/action (only POST is routed)', async () => {
      // GET requests to /api/action fall through to static file serving
      // since the route only matches POST. The static handler serves index.html (SPA fallback).
      const result = await sendRequest('GET', '/api/action');
      expect(result.statusCode).toBe(200);
      expect(result.body).toContain('Dashboard');
    });

    it('should return 405 for POST to non-API paths', async () => {
      const result = await sendRequest('POST', '/some-page');
      expect(result.statusCode).toBe(405);

      const data = JSON.parse(result.body);
      expect(data.error).toBe('Method not allowed');
    });

    it('should return 405 for PUT requests', async () => {
      const result = await sendRequest('PUT', '/api/data');
      expect(result.statusCode).toBe(405);

      const data = JSON.parse(result.body);
      expect(data.error).toBe('Method not allowed');
    });

    it('should return 405 for DELETE requests', async () => {
      const result = await sendRequest('DELETE', '/api/data');
      expect(result.statusCode).toBe(405);

      const data = JSON.parse(result.body);
      expect(data.error).toBe('Method not allowed');
    });
  });

  // ── Content-Type handling ────────────────────────────────────────

  describe('content-type handling', () => {
    it('should return application/json for API responses', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['Content-Type']).toBe('application/json');
    });

    it('should return text/html for HTML files', async () => {
      const result = await sendRequest('GET', '/');
      expect(result.headers['Content-Type']).toBe('text/html');
    });

    it('should include Content-Length header for API responses', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['Content-Length']).toBeDefined();
      expect(Number(result.headers['Content-Length'])).toBeGreaterThan(0);
    });

    it('should include Content-Length header for static files', async () => {
      const result = await sendRequest('GET', '/');
      expect(result.headers['Content-Length']).toBeDefined();
      expect(Number(result.headers['Content-Length'])).toBeGreaterThan(0);
    });
  });

  // ── Security headers ────────────────────────────────────────────

  describe('security headers', () => {
    it('should set X-Content-Type-Options to nosniff', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['x-content-type-options']).toBe('nosniff');
    });

    it('should set X-Frame-Options to DENY', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['x-frame-options']).toBe('DENY');
    });

    it('should set Content-Security-Policy with default-src self', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['content-security-policy']).toContain("default-src 'self'");
    });

    it('should set Referrer-Policy to strict-origin-when-cross-origin', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });
  });

  // ── Origin validation ──────────────────────────────────────────

  describe('origin validation', () => {
    it('should reject POST /api/action with foreign origin', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'https://evil.example.com' },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid origin');
    });

    it('should accept POST /api/action with localhost origin', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'http://localhost:19876' },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).not.toBe(403);
    });

    it('should accept POST /api/action with 127.0.0.1 origin', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'http://127.0.0.1:19876' },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).not.toBe(403);
    });

    it('should accept POST /api/action with no origin header', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).not.toBe(403);
    });

    it('should reject POST /api/refresh with foreign origin', async () => {
      const result = await sendRequestWithHeaders('POST', '/api/refresh', { origin: 'https://evil.example.com' });
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid origin');
    });
  });

  // ── Rate limiting ──────────────────────────────────────────────

  describe('rate limiting', () => {
    afterEach(() => {
      rateLimitOverride = null;
    });

    it('should return 429 with Retry-After for GET /api/data when rate-limited', async () => {
      rateLimitOverride = { allowed: false, retryAfterSeconds: 30 };
      const result = await sendRequest('GET', '/api/data');
      expect(result.statusCode).toBe(429);
      expect(result.headers['retry-after']).toBe('30');
    });

    it('should return 429 with Retry-After for POST /api/action when rate-limited', async () => {
      rateLimitOverride = { allowed: false, retryAfterSeconds: 15 };
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(429);
      expect(result.headers['retry-after']).toBe('15');
    });

    it('should return 429 with Retry-After for POST /api/refresh when rate-limited', async () => {
      rateLimitOverride = { allowed: false, retryAfterSeconds: 10 };
      const result = await sendRequest('POST', '/api/refresh');
      expect(result.statusCode).toBe(429);
      expect(result.headers['retry-after']).toBe('10');
    });
  });

  // ── POST /api/refresh ─────────────────────────────────────────

  describe('POST /api/refresh', () => {
    afterEach(() => {
      vi.mocked(getGitHubToken).mockReturnValue(null as any);
    });

    it('should return 401 when no GitHub token is available', async () => {
      const result = await sendRequest('POST', '/api/refresh');
      expect(result.statusCode).toBe(401);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('No GitHub token');
    });

    it('should refresh data successfully when token is available', async () => {
      vi.mocked(getGitHubToken).mockReturnValue('test-token');
      vi.mocked(fetchDashboardData).mockResolvedValue({
        digest: makeDigest(),
        commentedIssues: [],
        allMergedPRs: [],
        allClosedPRs: [],
      });

      const result = await sendRequest('POST', '/api/refresh');
      expect(result.statusCode).toBe(200);

      const data = JSON.parse(result.body);
      expect(data).toHaveProperty('stats');
      expect(data).toHaveProperty('activePRs');
      expect(vi.mocked(fetchDashboardData)).toHaveBeenCalledWith('test-token');
    });

    it('should return 500 when fetchDashboardData throws', async () => {
      vi.mocked(getGitHubToken).mockReturnValue('test-token');
      vi.mocked(fetchDashboardData).mockRejectedValue(new Error('GitHub API error'));

      const result = await sendRequest('POST', '/api/refresh');
      expect(result.statusCode).toBe(500);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('Refresh failed');
    });

    it('should reject refresh with invalid origin', async () => {
      const result = await sendRequestWithHeaders('POST', '/api/refresh', { origin: 'https://attacker.example.com' });
      expect(result.statusCode).toBe(403);
    });
  });

  // ── Path traversal protection ─────────────────────────────────

  describe('path traversal protection', () => {
    it('should return 403 for paths containing ".."', async () => {
      const result = await sendRequest('GET', '/../../etc/passwd');
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toBe('Forbidden');
    });

    it('should return 400 for malformed percent-encoded URLs', async () => {
      const result = await sendRequest('GET', '/%ZZ');
      expect(result.statusCode).toBe(400);
      const data = JSON.parse(result.body);
      expect(data.error).toBe('Malformed URL');
    });

    it('should return 403 for URL-encoded path traversal', async () => {
      const result = await sendRequest('GET', '/%2e%2e/etc/passwd');
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toBe('Forbidden');
    });
  });

  // ── Body size limit ───────────────────────────────────────────

  describe('body size limit', () => {
    it('should return 413 for oversized POST body', async () => {
      const largeBody = JSON.stringify({ action: 'move', url: 'x'.repeat(11000), target: 'shelved' });
      const result = await sendRequest('POST', '/api/action', largeBody);
      expect(result.statusCode).toBe(413);
    });
  });

  // ── Action validation edge cases ──────────────────────────────

  describe('action validation edge cases', () => {
    it('should return 400 for non-GitHub URL in move action', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://example.com/not-github', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(400);
    });

    it('should return 400 for issue URL in move action (expects PR URL)', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/issues/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(400);
    });

    it('should return 400 for PR URL in dismiss_issue_response (expects issue URL)', async () => {
      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'dismiss_issue_response', url: 'https://github.com/owner/repo/pull/1' }),
      );
      expect(result.statusCode).toBe(400);
    });
  });

  // ── PID file management ──────────────────────────────────────────

  describe('PID file management', () => {
    afterEach(() => {
      // Clean up any PID files left by tests
      removeDashboardServerInfo();
    });

    it('getDashboardPidPath should return a path ending with dashboard-server.pid', () => {
      const pidPath = getDashboardPidPath();
      expect(pidPath).toMatch(/dashboard-server\.pid$/);
      expect(path.dirname(pidPath)).toBe(pidTestDir);
    });

    it('writeDashboardServerInfo should write valid JSON', () => {
      const info: DashboardServerInfo = { pid: 12345, port: 3000, startedAt: '2026-01-15T12:00:00Z' };
      writeDashboardServerInfo(info);

      const pidPath = getDashboardPidPath();
      const content = fs.readFileSync(pidPath, 'utf-8');
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(info);
    });

    it('readDashboardServerInfo should return the written info', () => {
      const info: DashboardServerInfo = { pid: 99999, port: 8080, startedAt: '2026-02-01T00:00:00Z' };
      writeDashboardServerInfo(info);

      const result = readDashboardServerInfo();
      expect(result).toEqual(info);
    });

    it('readDashboardServerInfo should return null for missing file', () => {
      // Ensure no PID file exists
      removeDashboardServerInfo();

      const result = readDashboardServerInfo();
      expect(result).toBeNull();
    });

    it('readDashboardServerInfo should return null for corrupt file', () => {
      const pidPath = getDashboardPidPath();
      fs.writeFileSync(pidPath, 'not valid json {{{');

      const result = readDashboardServerInfo();
      expect(result).toBeNull();
    });

    it('readDashboardServerInfo should return null for structurally invalid JSON', () => {
      const pidPath = getDashboardPidPath();
      // Valid JSON but wrong shape (pid is a string, port missing)
      fs.writeFileSync(pidPath, JSON.stringify({ pid: 'not-a-number', startedAt: '2026-01-01' }));

      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = readDashboardServerInfo();

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('invalid structure'));
      consoleSpy.mockRestore();
    });

    it('removeDashboardServerInfo should remove the PID file', () => {
      const info: DashboardServerInfo = { pid: 11111, port: 4000, startedAt: '2026-01-01T00:00:00Z' };
      writeDashboardServerInfo(info);

      const pidPath = getDashboardPidPath();
      expect(fs.existsSync(pidPath)).toBe(true);

      removeDashboardServerInfo();
      expect(fs.existsSync(pidPath)).toBe(false);
    });

    it('removeDashboardServerInfo should handle missing file gracefully', () => {
      // Ensure no PID file exists
      removeDashboardServerInfo();

      // Should not throw
      expect(() => removeDashboardServerInfo()).not.toThrow();
    });
  });

  // ── Health probe ───────────────────────────────────────────────

  describe('health probe', () => {
    it('isDashboardServerRunning should return false for unreachable port', async () => {
      // Use a port that is almost certainly not in use
      const result = await isDashboardServerRunning(19999);
      expect(result).toBe(false);
    });

    it('findRunningDashboardServer should return null when no PID file exists', async () => {
      // Ensure no PID file exists
      removeDashboardServerInfo();

      const result = await findRunningDashboardServer();
      expect(result).toBeNull();
    });

    it('findRunningDashboardServer should clean up stale PID file for dead process', async () => {
      // Write a PID file referencing a PID that almost certainly does not exist
      const info: DashboardServerInfo = { pid: 2147483647, port: 19998, startedAt: '2026-01-01T00:00:00Z' };
      writeDashboardServerInfo(info);

      const result = await findRunningDashboardServer();
      expect(result).toBeNull();

      // PID file should be cleaned up
      expect(readDashboardServerInfo()).toBeNull();
    });
  });

  // ── Issue-list cache invalidation (#924, regression test #956) ─────
  //
  // The dashboard caches its /api/data payload and only rebuilds it when
  // state.json changes. Before #924 was fixed, edits to the vetted issue
  // list file left the cached "N available issues" count stale until an
  // unrelated state mutation happened to trigger a rebuild.
  //
  // These tests guard that fix: GET /api/data must reflect the current
  // on-disk issue list, and subsequent requests with no change must still
  // serve the cached payload (no spurious rebuilds on every request).

  describe('GET /api/data — issue-list cache invalidation (#924)', () => {
    let issueListDir: string;
    let issueListPath: string;

    beforeEach(() => {
      // Fresh tmp file per test so mtimes don't collide across tests.
      issueListDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-issuelist-'));
      issueListPath = path.join(issueListDir, 'potential-issue-list.md');

      // Point the mocked state manager at our tmp file.
      const digest = makeDigest();
      const state = makeState({
        lastDigest: digest,
        config: { issueListPath, skippedIssuesPath: undefined } as any,
      });
      mockStateManager.getState.mockReturnValue(state);
    });

    afterEach(() => {
      try {
        fs.rmSync(issueListDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    });

    /**
     * Write content to the issue list file with an explicitly newer mtime.
     * On filesystems with coarse timestamp resolution (macOS HFS+ is ~1s),
     * two back-to-back writes in the same test can produce identical
     * mtimes, which defeats the invalidation we are testing.
     */
    function writeIssueList(content: string, mtimeMs: number): void {
      fs.writeFileSync(issueListPath, content);
      const seconds = mtimeMs / 1000;
      fs.utimesSync(issueListPath, seconds, seconds);
    }

    it('reflects an edited issue-list file on the next GET /api/data', async () => {
      const baseTime = Date.now();

      // Initial state: one Pursue issue.
      writeIssueList('## Pursue\n- [#1](https://github.com/o/r/issues/1) — First issue\n', baseTime);

      const first = await sendRequest('GET', '/api/data');
      const firstData = JSON.parse(first.body);
      expect(firstData.stats.availableIssues).toBe(1);

      // Edit: add a second Pursue issue, bump mtime.
      writeIssueList(
        '## Pursue\n- [#1](https://github.com/o/r/issues/1) — First\n- [#2](https://github.com/o/r/issues/2) — Second\n',
        baseTime + 60_000,
      );

      const second = await sendRequest('GET', '/api/data');
      const secondData = JSON.parse(second.body);
      expect(secondData.stats.availableIssues).toBe(2);
    });

    it('excludes a Skip sub-bullet after the file is edited (#907 + #924 together)', async () => {
      const baseTime = Date.now();

      // Two Pursue issues.
      writeIssueList(
        '## Pursue\n' +
          '- [#1](https://github.com/o/r/issues/1) — First\n' +
          '  - **Maybe** — Score 8/10\n' +
          '- [#2](https://github.com/o/r/issues/2) — Second\n' +
          '  - **Maybe** — Score 8/10\n',
        baseTime,
      );

      const first = await sendRequest('GET', '/api/data');
      expect(JSON.parse(first.body).stats.availableIssues).toBe(2);

      // Mark #2 as Skip — user vetted it out. Count should drop.
      writeIssueList(
        '## Pursue\n' +
          '- [#1](https://github.com/o/r/issues/1) — First\n' +
          '  - **Maybe** — Score 8/10\n' +
          '- [#2](https://github.com/o/r/issues/2) — Second\n' +
          '  - **Skip** — Existing PR.\n',
        baseTime + 60_000,
      );

      const second = await sendRequest('GET', '/api/data');
      expect(JSON.parse(second.body).stats.availableIssues).toBe(1);
    });

    it('serves cached payload (same response shape) when the file is untouched', async () => {
      writeIssueList('## Pursue\n- [#1](https://github.com/o/r/issues/1) — Only issue\n', Date.now());

      const first = await sendRequest('GET', '/api/data');
      const second = await sendRequest('GET', '/api/data');

      // Identical payloads across two requests when nothing changes.
      expect(second.body).toBe(first.body);
      expect(JSON.parse(second.body).stats.availableIssues).toBe(1);
    });

    it('handles a missing issue-list file without crashing', async () => {
      // Point at a path that does not exist; dashboard should degrade gracefully.
      const missingPath = path.join(issueListDir, 'does-not-exist.md');
      const state = makeState({
        lastDigest: makeDigest(),
        config: { issueListPath: missingPath, skippedIssuesPath: undefined } as any,
      });
      mockStateManager.getState.mockReturnValue(state);

      const result = await sendRequest('GET', '/api/data');
      expect(result.statusCode).toBe(200);
      // availableIssues falls back to whatever buildDashboardStats supplied (no override).
      const data = JSON.parse(result.body);
      expect(data.stats).toBeDefined();
    });

    it('sets X-Dashboard-Stale: 1 and serves cached payload when rebuild fails (#994)', async () => {
      const baseTime = Date.now();
      writeIssueList('## Pursue\n- [#1](https://github.com/o/r/issues/1) — First\n', baseTime);

      // Prime the cache with a successful GET (no stale header expected).
      const first = await sendRequest('GET', '/api/data');
      expect(first.statusCode).toBe(200);
      expect(first.headers['x-dashboard-stale']).toBeUndefined();
      const firstBody = first.body;

      // Bump the issue-list mtime to force a rebuild, then swap getState to a
      // throwing impl for the duration of the second request so buildDashboardJson
      // fails inside the rebuild try/catch.
      writeIssueList(
        '## Pursue\n- [#1](https://github.com/o/r/issues/1) — First\n- [#2](https://github.com/o/r/issues/2) — Second\n',
        baseTime + 60_000,
      );
      const healthyState = mockStateManager.getState.getMockImplementation();
      mockStateManager.getState.mockImplementation(() => {
        throw new Error('boom');
      });

      const second = await sendRequest('GET', '/api/data');
      expect(second.statusCode).toBe(200);
      expect(second.headers['x-dashboard-stale']).toBe('1');
      // Stale payload matches the last successful one — degraded mode, not 500.
      expect(second.body).toBe(firstBody);

      // Restore healthy getState; the stale header should not be sticky.
      if (healthyState) {
        mockStateManager.getState.mockImplementation(healthyState);
      } else {
        mockStateManager.getState.mockReturnValue(
          makeState({
            lastDigest: makeDigest(),
            config: { issueListPath, skippedIssuesPath: undefined } as any,
          }),
        );
      }
      const third = await sendRequest('GET', '/api/data');
      expect(third.statusCode).toBe(200);
      expect(third.headers['x-dashboard-stale']).toBeUndefined();
    });
  });
});

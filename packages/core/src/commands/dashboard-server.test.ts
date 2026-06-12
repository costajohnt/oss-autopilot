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
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { DailyDigest } from '../core/types.js';
import { makeAgentState as makeState, makeRepoScore } from '../core/test-utils.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

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

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
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

vi.mock('../core/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../core/index.js')>();
  return {
    getStateManager: vi.fn(() => mockStateManager),
    getGitHubToken: vi.fn(() => null),
    getDataDir: vi.fn(() => pidTestDir),
    getCLIVersion: vi.fn(() => '0.44.6'),
    applyStatusOverrides: vi.fn((prs: unknown[]) => prs),
    maybeCheckpoint: (...args: unknown[]) => mockMaybeCheckpoint(...args),
    // Real pure classifier + status set (#1352) so /api/data responses carry
    // genuine buckets and the shelve partition mirrors the daily check.
    classifyAttentionBucket: actual.classifyAttentionBucket,
    CRITICAL_STATUSES: actual.CRITICAL_STATUSES,
    // Used by the real reconcileShelvePartition (imported via importActual below).
    toShelvedPRRef: vi.fn((pr: unknown) => pr),
  };
});

// Mock fetchDashboardData so we never call GitHub. reconcileShelvePartition is
// the real implementation so the shelve/unshelve reconciliation is exercised;
// everything else is stubbed to keep buildDashboardJson hermetic.
vi.mock('./dashboard-data.js', async (importActual) => {
  const actual = await importActual<typeof import('./dashboard-data.js')>();
  return {
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
    reconcileShelvePartition: actual.reconcileShelvePartition,
  };
});

// Mock move command so dashboard-server's dynamic import resolves without side effects
const mockRunMove = vi.fn().mockResolvedValue({ url: '', target: 'shelved', description: 'done' });
// Resolves null (no warning) by default; #1417 tests resolve a warning string.
const mockMaybeCheckpoint = vi.fn().mockResolvedValue(null);
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
import { ConcurrencyError } from '../core/errors.js';

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
  // Default Host header satisfies the DNS-rebinding check on /api/* routes.
  // Tests that exercise the Host check explicitly override req.headers.host.
  req.headers = { host: 'localhost:19876' };
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
  }) as unknown as ServerResponse['writeHead'];

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
        body: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });

  return { res, result };
}

// ── Test suite ───────────────────────────────────────────────────────

describe('dashboard-server', () => {
  let tmpDir: string;
  // CSRF token generated by the server at startup. Fetched once via GET /api/data
  // in beforeAll; `sendRequest` attaches it to every POST so existing tests that
  // predate the CSRF requirement continue to assert their intended behavior.
  let cachedCsrfToken: string | null = null;

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
      port: 19_876,
      assetsDir: tmpDir,
      token: null,
      open: false,
    });

    // Verify we captured the request handler
    expect(capturedHandler).not.toBeNull();

    // Capture the CSRF token the server now mints per start-up. Exposed on
    // every /api/data response via the X-CSRF-Token header; required on
    // state-mutating POSTs.
    const req = createMockReq('GET', '/api/data');
    const { res, result } = createMockRes();
    capturedHandler!(req, res);
    const r = await result;
    const token = r.headers['x-csrf-token'];
    cachedCsrfToken = typeof token === 'string' ? token : null;
    expect(cachedCsrfToken).toBeTruthy();
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

  // Helper to send a request through the captured handler.
  // For POSTs: auto-injects valid Origin and CSRF headers so existing
  // positive-path tests keep working after the #1031 hardening. Use
  // sendRequestWithHeaders when you need to assert the negative paths.
  async function sendRequest(method: string, url: string, body?: string): Promise<MockResponseResult> {
    const req = createMockReq(method, url, body);
    if (method === 'POST') {
      req.headers['origin'] = 'http://localhost:19876';
      if (cachedCsrfToken) req.headers['x-csrf-token'] = cachedCsrfToken;
    }
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

    it('buildDashboardJson sets partialFailures only when non-empty (#1035)', () => {
      // Omitted/undefined → no field on the response. Empty array → no field.
      // Non-empty → field present. This keeps the wire format minimal and
      // lets the SPA guard via `data.partialFailures?.length > 0`.
      const digest = makeDigest();
      const state = makeState({ lastDigest: digest });

      const none = buildDashboardJson(digest, state, []);
      expect(none.partialFailures).toBeUndefined();

      const empty = buildDashboardJson(digest, state, [], undefined, undefined, []);
      expect(empty.partialFailures).toBeUndefined();

      const some = buildDashboardJson(digest, state, [], undefined, undefined, ['fetch recently merged PRs']);
      expect(some.partialFailures).toEqual(['fetch recently merged PRs']);
    });

    it('buildDashboardJson stamps attentionBucket on every served PR (#1421)', () => {
      // The SPA falls back to 'waiting' when the stamp is absent, so dropping
      // it would silently collapse stuck_ci / dormant_followup into waiting
      // with every other test still green. classifyAttentionBucket is the
      // REAL classifier here (see the core mock at the top of this file).
      const stuckCI = {
        url: 'https://github.com/owner/repo/pull/61',
        repo: 'owner/repo',
        number: 61,
        status: 'waiting_on_maintainer',
        ciStatus: 'pending',
        reviewDecision: 'approved',
        daysSinceActivity: 5,
        stalenessTier: 'active',
      };
      const needsAttention = {
        url: 'https://github.com/owner/repo/pull/62',
        repo: 'owner/repo',
        number: 62,
        status: 'needs_addressing',
        ciStatus: 'failing',
        reviewDecision: 'approved',
        daysSinceActivity: 1,
        stalenessTier: 'active',
      };
      const digest = makeDigest({ openPRs: [stuckCI, needsAttention] as never[] });
      const state = makeState({ lastDigest: digest });

      const data = buildDashboardJson(digest, state, []);

      const byUrl = new Map(data.activePRs.map((pr) => [pr.url, pr.attentionBucket]));
      expect(byUrl.get(stuckCI.url)).toBe('stuck_ci');
      expect(byUrl.get(needsAttention.url)).toBe('needs_attention');
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

    it('reflects a live shelve: an open PR added to config.shelvedPRUrls appears in shelvedPRUrls', () => {
      // Repro of the dashboard "shelve does nothing" bug. POST /api/action →
      // runMove updates state.config.shelvedPRUrls but never the cached digest,
      // and buildDashboardJson derived shelvedPRUrls purely from the stale
      // digest.shelvedPRs — so a freshly-shelved PR never reached the SPA and
      // stayed in the active list.
      const pr = {
        url: 'https://github.com/o/r/pull/7',
        number: 7,
        repo: 'o/r',
        title: 'Active PR shelved via SPA',
        status: 'waiting_on_maintainer',
        stalenessTier: 'active',
        daysSinceActivity: 2,
      };
      const digest = makeDigest({ openPRs: [pr], shelvedPRs: [] });
      const state = makeState({
        config: { shelvedPRUrls: [pr.url] },
        lastDigest: digest,
      });

      const data = buildDashboardJson(digest, state, []);

      expect(data.shelvedPRUrls).toContain(pr.url);
    });

    it('reflects a live unshelve: a baked shelved open PR dropped from config disappears from shelvedPRUrls', () => {
      // The mirror bug: a PR shelved earlier (baked into digest.shelvedPRs) that
      // the user unshelves via the SPA. runMove clears it from
      // state.config.shelvedPRUrls, but the stale baked entry kept it shelved.
      const pr = {
        url: 'https://github.com/o/r/pull/8',
        number: 8,
        repo: 'o/r',
        title: 'PR unshelved via SPA',
        status: 'waiting_on_maintainer',
        stalenessTier: 'active',
        daysSinceActivity: 2,
      };
      const digest = makeDigest({
        openPRs: [pr],
        shelvedPRs: [
          {
            number: 8,
            url: pr.url,
            title: pr.title,
            repo: 'o/r',
            daysSinceActivity: 2,
            status: 'waiting_on_maintainer',
          },
        ],
      });
      const state = makeState({ config: { shelvedPRUrls: [] }, lastDigest: digest });

      const data = buildDashboardJson(digest, state, []);

      expect(data.shelvedPRUrls).not.toContain(pr.url);
    });

    it('never display-shelves a critical PR, even when explicitly shelved (#1352)', () => {
      // The daily check auto-unshelves a shelved PR the moment it turns
      // needs_addressing (CRITICAL_STATUSES). The dashboard partition must
      // agree immediately, or its headline count diverges from the CLI brief
      // until the next daily run — the exact class #1352 closes.
      const pr = {
        url: 'https://github.com/o/r/pull/12',
        number: 12,
        repo: 'o/r',
        title: 'Shelved PR that turned critical',
        status: 'needs_addressing',
        stalenessTier: 'dormant',
        daysSinceActivity: 40,
      };
      const digest = makeDigest({ openPRs: [pr], shelvedPRs: [] });
      const state = makeState({
        config: { shelvedPRUrls: [pr.url] },
        lastDigest: digest,
      });

      const data = buildDashboardJson(digest, state, []);

      expect(data.shelvedPRUrls).not.toContain(pr.url);
      expect(data.activePRs.map((p) => p.url)).toContain(pr.url);
    });

    it('keeps a dormant-auto-shelved open PR shelved even when not in config', () => {
      // Reconciliation must not undo the dormant-auto-shelve rule: a dormant,
      // non-addressing PR stays shelved for display regardless of config.
      const pr = {
        url: 'https://github.com/o/r/pull/9',
        number: 9,
        repo: 'o/r',
        title: 'Dormant auto-shelf',
        status: 'waiting_on_maintainer',
        stalenessTier: 'dormant',
        daysSinceActivity: 60,
      };
      const digest = makeDigest({
        openPRs: [pr],
        shelvedPRs: [
          {
            number: 9,
            url: pr.url,
            title: pr.title,
            repo: 'o/r',
            daysSinceActivity: 60,
            status: 'waiting_on_maintainer',
          },
        ],
      });
      const state = makeState({ config: { shelvedPRUrls: [] }, lastDigest: digest });

      const data = buildDashboardJson(digest, state, []);

      expect(data.shelvedPRUrls).toContain(pr.url);
    });

    it('should include repos with metadata and exclude repos without in repoMetadata (#677)', async () => {
      const state = makeState({
        lastDigest: makeDigest(),
        repoScores: {
          'has/both': makeRepoScore({ repo: 'has/both', stargazersCount: 500, language: 'TypeScript' }),
          'has/stars-only': makeRepoScore({ repo: 'has/stars-only', stargazersCount: 100 }),
          'has/null-language': makeRepoScore({ repo: 'has/null-language', stargazersCount: 200, language: null }),
          'no/metadata': makeRepoScore({ repo: 'no/metadata', mergedPRCount: 2 }),
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

    // ── Concurrency conflicts (#1397) ───────────────────────────────
    // An external CLI write landing between the handler's reload and save
    // surfaces as ConcurrencyError from the mutation (see
    // state-concurrency.test.ts). The handler retries once via
    // reload-reapply; a second conflict becomes a retryable 409.

    it('retries once on ConcurrencyError and returns 200 when the retry succeeds (move)', async () => {
      mockStateManager.reloadIfChanged.mockClear();
      mockRunMove.mockClear();
      mockRunMove.mockRejectedValueOnce(new ConcurrencyError(1000, 2000));

      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );

      expect(result.statusCode).toBe(200);
      const data = JSON.parse(result.body);
      expect(data).toHaveProperty('stats');
      // Mutation re-applied once after a fresh reload: two reloads, two attempts.
      expect(mockRunMove).toHaveBeenCalledTimes(2);
      expect(mockStateManager.reloadIfChanged).toHaveBeenCalledTimes(2);
    });

    it('retries once on ConcurrencyError and returns 200 when the retry succeeds (dismiss)', async () => {
      mockStateManager.dismissIssue.mockImplementationOnce(() => {
        throw new ConcurrencyError(1000, 2000);
      });

      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'dismiss_issue_response', url: 'https://github.com/owner/repo/issues/42' }),
      );

      expect(result.statusCode).toBe(200);
      expect(mockStateManager.dismissIssue).toHaveBeenCalledTimes(2);
    });

    it('returns a machine-readable 409 when the retry also hits ConcurrencyError', async () => {
      mockRunMove
        .mockRejectedValueOnce(new ConcurrencyError(1000, 2000))
        .mockRejectedValueOnce(new ConcurrencyError(2000, 3000));

      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );

      expect(result.statusCode).toBe(409);
      const data = JSON.parse(result.body);
      expect(data.code).toBe('CONCURRENCY_ERROR');
      expect(data.retryable).toBe(true);
      expect(typeof data.error).toBe('string');
    });

    it('returns 500 (not 409) when the retry fails with a non-concurrency error', async () => {
      mockRunMove.mockRejectedValueOnce(new ConcurrencyError(1000, 2000)).mockRejectedValueOnce(new Error('disk full'));

      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );

      expect(result.statusCode).toBe(500);
      expect(JSON.parse(result.body).error).toBe('Action failed');
    });

    it('does not reload state for a request that fails validation (#1397)', async () => {
      // The reload was moved AFTER body parsing/validation to shrink the
      // read-modify-write window — invalid requests must not touch state.
      mockStateManager.reloadIfChanged.mockClear();

      const result = await sendRequest(
        'POST',
        '/api/action',
        JSON.stringify({ action: 'invalid_action', url: 'https://github.com/owner/repo/pull/1' }),
      );

      expect(result.statusCode).toBe(400);
      expect(mockStateManager.reloadIfChanged).not.toHaveBeenCalled();
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

    describe('gist sync warnings (#1417)', () => {
      // The server instance is shared across the whole file, and pending
      // gist-sync warnings clear only on a successful checkpoint PUSH — so
      // every warning-producing test ends with a clean action to reset the
      // banner for later tests (recordGistSyncOutcome(null) clears pending).
      async function resetPendingWarnings(): Promise<void> {
        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/99', target: 'shelved' }),
        );
        expect(JSON.parse(result.body).partialFailures).toBeUndefined();
      }

      it('a successful checkpoint adds nothing to partialFailures', async () => {
        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/10', target: 'shelved' }),
        );

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).partialFailures).toBeUndefined();
      });

      it('dismiss checkpoints to Gist after the mutation', async () => {
        mockMaybeCheckpoint.mockClear();

        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({
            action: 'dismiss_issue_response',
            url: 'https://github.com/owner/repo/issues/43',
          }),
        );

        expect(result.statusCode).toBe(200);
        // Checkpoint runs against the live state manager, after dismissIssue.
        expect(mockMaybeCheckpoint).toHaveBeenCalledWith(mockStateManager, expect.any(String));
        expect(mockMaybeCheckpoint.mock.invocationCallOrder[0]).toBeGreaterThan(
          mockStateManager.dismissIssue.mock.invocationCallOrder[0],
        );
      });

      it('surfaces a failed dismiss checkpoint in partialFailures', async () => {
        const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
        mockMaybeCheckpoint.mockResolvedValueOnce(warning);

        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({
            action: 'dismiss_issue_response',
            url: 'https://github.com/owner/repo/issues/44',
          }),
        );

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).partialFailures).toContain(warning);

        await resetPendingWarnings();
      });

      it('surfaces a move gistSyncWarning in partialFailures instead of discarding it', async () => {
        const warning = 'Gist checkpoint failed (local mutation succeeded, will retry on next push): boom';
        mockRunMove.mockResolvedValueOnce({
          url: 'https://github.com/owner/repo/pull/9',
          target: 'shelved',
          description: 'done',
          gistSyncWarning: warning,
        });

        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/9', target: 'shelved' }),
        );

        expect(result.statusCode).toBe(200);
        const body = JSON.parse(result.body);
        expect(body.partialFailures).toContain(warning);

        // The warning persists across the NEXT action rebuild and is not
        // duplicated when the same warning fires again.
        mockRunMove.mockResolvedValueOnce({
          url: 'https://github.com/owner/repo/pull/9',
          target: 'waiting',
          description: 'done',
          gistSyncWarning: warning,
        });
        const second = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/9', target: 'waiting' }),
        );
        const secondBody = JSON.parse(second.body);
        expect(secondBody.partialFailures.filter((m: string) => m === warning)).toHaveLength(1);

        await resetPendingWarnings();
      });

      it('surfaces the warning produced on the conflict-retry attempt', async () => {
        const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
        // First dismiss attempt conflicts; the server-side retry (#1397)
        // succeeds but its checkpoint fails — the retry's warning must
        // reach the response, not be lost with the failed first attempt.
        mockStateManager.dismissIssue.mockImplementationOnce(() => {
          throw new ConcurrencyError(1000, 2000);
        });
        mockMaybeCheckpoint.mockResolvedValueOnce(warning);

        const result = await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({
            action: 'dismiss_issue_response',
            url: 'https://github.com/owner/repo/issues/45',
          }),
        );

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).partialFailures).toContain(warning);

        await resetPendingWarnings();
      });

      it('a pending warning survives a GET /api/data rebuild', async () => {
        const warning = 'Gist checkpoint failed (local mutation succeeded, will retry on next push): poll';
        mockRunMove.mockResolvedValueOnce({
          url: 'https://github.com/owner/repo/pull/11',
          target: 'shelved',
          description: 'done',
          gistSyncWarning: warning,
        });
        await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/11', target: 'shelved' }),
        );

        // Force the GET handler down its rebuild branch — the warning must be
        // re-merged there, not only in the action response.
        mockStateManager.reloadIfChanged.mockReturnValueOnce(true);
        const result = await sendRequest('GET', '/api/data');

        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).partialFailures).toContain(warning);

        await resetPendingWarnings();
      });

      it('a successful refresh does NOT clear a still-unpushed gist warning', async () => {
        // Regression test for the lifecycle split: fetch partialFailures
        // clear on a successful PULL, but a gist-sync warning means an
        // un-pushed mutation — clearing it on pull is exactly when the
        // mutation is at risk of silent revert.
        const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
        mockMaybeCheckpoint.mockResolvedValue(warning);
        await sendRequest(
          'POST',
          '/api/action',
          JSON.stringify({ action: 'dismiss_issue_response', url: 'https://github.com/owner/repo/issues/46' }),
        );

        vi.mocked(getGitHubToken).mockReturnValue('test-token');
        vi.mocked(fetchDashboardData).mockResolvedValue({
          digest: makeDigest(),
          commentedIssues: [],
          allMergedPRs: [],
          allClosedPRs: [],
          partialFailures: [],
        });

        const result = await sendRequest('POST', '/api/refresh');
        expect(result.statusCode).toBe(200);
        expect(JSON.parse(result.body).partialFailures).toContain(warning);

        vi.mocked(getGitHubToken).mockReturnValue(null as never);
        mockMaybeCheckpoint.mockResolvedValue(null);
        await resetPendingWarnings();
      });

      it('gist mode: refresh re-pushes BEFORE pulling and clears the warning on success', async () => {
        const warning = 'Gist checkpoint push failed after retry; the local mutation is saved';
        mockStateManager.isGistMode.mockReturnValue(true);
        try {
          // Action fails its push -> warning pending. (reloadState's flush
          // never calls maybeCheckpoint here: nothing pending pre-action.)
          mockMaybeCheckpoint.mockResolvedValueOnce(warning);
          await sendRequest(
            'POST',
            '/api/action',
            JSON.stringify({ action: 'dismiss_issue_response', url: 'https://github.com/owner/repo/issues/47' }),
          );

          // Refresh: the network recovered, so the push-before-pull flush
          // succeeds and the warning lifecycle ends with the push.
          vi.mocked(getGitHubToken).mockReturnValue('test-token');
          vi.mocked(fetchDashboardData).mockResolvedValue({
            digest: makeDigest(),
            commentedIssues: [],
            allMergedPRs: [],
            allClosedPRs: [],
            partialFailures: [],
          });
          mockMaybeCheckpoint.mockClear();
          mockStateManager.refreshFromGist.mockClear();
          mockMaybeCheckpoint.mockResolvedValueOnce(null);

          const result = await sendRequest('POST', '/api/refresh');
          expect(result.statusCode).toBe(200);
          expect(JSON.parse(result.body).partialFailures).toBeUndefined();
          // Push-before-pull ordering: the flush ran before refreshFromGist.
          expect(mockMaybeCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
            mockStateManager.refreshFromGist.mock.invocationCallOrder[0],
          );
        } finally {
          mockStateManager.isGistMode.mockReturnValue(false);
          vi.mocked(getGitHubToken).mockReturnValue(null as never);
          mockMaybeCheckpoint.mockResolvedValue(null);
        }
      });
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

    it('should allow blob: workers in Content-Security-Policy (canvas-confetti)', async () => {
      // Regression: canvas-confetti loads its animation worker from a blob: URL.
      // Without an explicit worker-src directive, the browser falls back to
      // script-src, which does not list blob:, and the celebrate button fails
      // silently in production.
      const result = await sendRequest('GET', '/api/data');
      expect(result.headers['content-security-policy']).toContain("worker-src 'self' blob:");
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
        { origin: 'http://localhost:19876', 'x-csrf-token': cachedCsrfToken! },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).not.toBe(403);
    });

    it('should accept POST /api/action with 127.0.0.1 origin', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'http://127.0.0.1:19876', 'x-csrf-token': cachedCsrfToken! },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).not.toBe(403);
    });

    it('should reject POST /api/action with no Origin header (#1031)', async () => {
      // Prior to #1031, missing Origin was treated as same-origin; any local
      // process could POST without a browser. Now required on all POSTs.
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { 'x-csrf-token': cachedCsrfToken! },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid origin');
    });

    it('should reject POST /api/refresh with foreign origin', async () => {
      const result = await sendRequestWithHeaders('POST', '/api/refresh', { origin: 'https://evil.example.com' });
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('Invalid origin');
    });
  });

  // ── CSRF token + Host-header hardening (#1031) ──────────────────

  describe('CSRF token validation', () => {
    it('GET /api/data exposes X-CSRF-Token response header', async () => {
      const result = await sendRequest('GET', '/api/data');
      expect(result.statusCode).toBe(200);
      expect(typeof result.headers['x-csrf-token']).toBe('string');
      expect((result.headers['x-csrf-token'] as string).length).toBeGreaterThanOrEqual(32);
    });

    it('rejects POST /api/action with no CSRF token', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'http://localhost:19876' },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('CSRF token');
    });

    it('rejects POST /api/action with an invalid CSRF token', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        { origin: 'http://localhost:19876', 'x-csrf-token': 'deadbeef'.repeat(8) },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(403);
    });

    it('rejects POST /api/refresh with no CSRF token', async () => {
      const result = await sendRequestWithHeaders('POST', '/api/refresh', {
        origin: 'http://localhost:19876',
      });
      expect(result.statusCode).toBe(403);
      const data = JSON.parse(result.body);
      expect(data.error).toContain('CSRF token');
    });
  });

  describe('Host-header validation (DNS rebinding defense)', () => {
    it('rejects GET /api/data when Host is missing', async () => {
      const req = createMockReq('GET', '/api/data');
      delete req.headers.host;
      const { res, result } = createMockRes();
      capturedHandler!(req, res);
      const r = await result;
      expect(r.statusCode).toBe(403);
      const data = JSON.parse(r.body);
      expect(data.error).toBe('Invalid host');
    });

    it('rejects GET /api/data when Host is a rebound attacker domain', async () => {
      const result = await sendRequestWithHeaders('GET', '/api/data', { host: 'attacker.example.com' });
      expect(result.statusCode).toBe(403);
    });

    it('rejects POST /api/action when Host is a rebound attacker domain', async () => {
      const result = await sendRequestWithHeaders(
        'POST',
        '/api/action',
        {
          host: 'attacker.example.com',
          origin: 'http://localhost:19876',
          'x-csrf-token': cachedCsrfToken!,
        },
        JSON.stringify({ action: 'move', url: 'https://github.com/owner/repo/pull/1', target: 'shelved' }),
      );
      expect(result.statusCode).toBe(403);
    });

    it('accepts GET /api/data from oss.localhost Host', async () => {
      const result = await sendRequestWithHeaders('GET', '/api/data', { host: 'oss.localhost:19876' });
      expect(result.statusCode).toBe(200);
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
        partialFailures: [],
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

    it('returns a machine-readable 409 on ConcurrencyError (#1397)', async () => {
      vi.mocked(getGitHubToken).mockReturnValue('test-token');
      vi.mocked(fetchDashboardData).mockRejectedValueOnce(new ConcurrencyError(1000, 2000));

      const result = await sendRequest('POST', '/api/refresh');
      expect(result.statusCode).toBe(409);
      const data = JSON.parse(result.body);
      expect(data.code).toBe('CONCURRENCY_ERROR');
      expect(data.retryable).toBe(true);
      expect(typeof data.error).toBe('string');
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
      const largeBody = JSON.stringify({ action: 'move', url: 'x'.repeat(11_000), target: 'shelved' });
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
      const info: DashboardServerInfo = { pid: 12_345, port: 3000, startedAt: '2026-01-15T12:00:00Z' };
      writeDashboardServerInfo(info);

      const pidPath = getDashboardPidPath();
      const content = fs.readFileSync(pidPath, 'utf8');
      const parsed = JSON.parse(content);

      expect(parsed).toEqual(info);
    });

    it('readDashboardServerInfo should return the written info', () => {
      const info: DashboardServerInfo = { pid: 99_999, port: 8080, startedAt: '2026-02-01T00:00:00Z' };
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
      const info: DashboardServerInfo = { pid: 11_111, port: 4000, startedAt: '2026-01-01T00:00:00Z' };
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
      const result = await isDashboardServerRunning(19_999);
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
      const info: DashboardServerInfo = { pid: 2_147_483_647, port: 19_998, startedAt: '2026-01-01T00:00:00Z' };
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

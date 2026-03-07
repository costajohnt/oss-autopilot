/**
 * Dashboard HTTP server.
 * Serves the Preact SPA from packages/dashboard/dist/ and provides API endpoints
 * for live data fetching and state mutations (shelve, unshelve, override, etc.).
 *
 * Uses Node's built-in http module — no Express/Fastify.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getStateManager, getGitHubToken, getCLIVersion } from '../core/index.js';
import { errorMessage, ValidationError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { validateUrl, validateGitHubUrl, PR_URL_PATTERN } from './validation.js';
import {
  fetchDashboardData,
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  buildDashboardStats,
  type DashboardStats,
} from './dashboard-data.js';
import { openInBrowser } from './startup.js';
import { writeDashboardServerInfo, removeDashboardServerInfo } from './dashboard-process.js';
import { RateLimiter } from './rate-limiter.js';
import type {
  DailyDigest,
  AgentState,
  CommentedIssue,
  CommentedIssueWithResponse,
  FetchedPR,
  MergedPR,
  ClosedPR,
  ShelvedPRRef,
} from '../core/types.js';

// Re-export process management functions for backward compatibility
export {
  getDashboardPidPath,
  writeDashboardServerInfo,
  readDashboardServerInfo,
  removeDashboardServerInfo,
  isDashboardServerRunning,
  findRunningDashboardServer,
  type DashboardServerInfo,
} from './dashboard-process.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DashboardServerOptions {
  port: number;
  assetsDir: string;
  token: string | null;
  open: boolean;
}

interface DashboardJsonData {
  stats: DashboardStats;
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  monthlyMerged: Record<string, number>;
  monthlyOpened: Record<string, number>;
  monthlyClosed: Record<string, number>;
  activePRs: FetchedPR[];
  shelvedPRUrls: string[];
  recentlyMergedPRs: MergedPR[];
  recentlyClosedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
  offline?: boolean;
  lastUpdated?: string;
}

interface ActionRequest {
  action: 'shelve' | 'unshelve' | 'override_status';
  url: string;
  /** Target status for override_status action. */
  status?: 'needs_addressing' | 'waiting_on_maintainer';
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ACTIONS: Set<ActionRequest['action']> = new Set(['shelve', 'unshelve', 'override_status']);

const MODULE = 'dashboard-server';

const MAX_BODY_BYTES = 10_240;

const REQUEST_TIMEOUT_MS = 30_000;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/**
 * Apply status overrides from state to the PR list.
 * Overrides are auto-cleared if the PR has new activity since the override was set.
 */
function applyStatusOverrides(prs: FetchedPR[], state: Readonly<AgentState>): FetchedPR[] {
  const overrides = state.config.statusOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return prs;

  const stateManager = getStateManager();
  // Snapshot keys before iteration — clearStatusOverride mutates the same object
  const overrideUrls = new Set(Object.keys(overrides));
  let didAutoClear = false;
  const result = prs.map((pr) => {
    const override = stateManager.getStatusOverride(pr.url, pr.updatedAt);
    if (!override) {
      if (overrideUrls.has(pr.url)) didAutoClear = true;
      return pr;
    }
    if (override.status === pr.status) return pr;
    return { ...pr, status: override.status };
  });

  // Persist any auto-cleared overrides so they don't resurrect on restart
  if (didAutoClear) {
    try {
      stateManager.save();
    } catch (err) {
      warn(MODULE, `Failed to persist auto-cleared overrides — they may reappear on restart: ${errorMessage(err)}`);
    }
  }

  return result;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the JSON payload that the SPA expects from GET /api/data.
 */
function buildDashboardJson(
  digest: DailyDigest,
  state: Readonly<AgentState>,
  commentedIssues: CommentedIssue[],
): DashboardJsonData {
  const prsByRepo = computePRsByRepo(digest, state);
  const topRepos = computeTopRepos(prsByRepo);
  const { monthlyMerged, monthlyOpened, monthlyClosed } = getMonthlyData(state);
  const stats = buildDashboardStats(digest, state);
  const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');

  return {
    stats,
    prsByRepo,
    topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
    monthlyMerged,
    monthlyOpened,
    monthlyClosed,
    activePRs: applyStatusOverrides(digest.openPRs || [], state),
    shelvedPRUrls: state.config.shelvedPRUrls || [],
    recentlyMergedPRs: digest.recentlyMergedPRs || [],
    recentlyClosedPRs: digest.recentlyClosedPRs || [],
    autoUnshelvedPRs: digest.autoUnshelvedPRs || [],
    commentedIssues,
    issueResponses,
  };
}

/**
 * Read the full request body as a UTF-8 string, with a size limit.
 */
function readBody(req: http.IncomingMessage, maxBytes: number = MAX_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalLength = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      totalLength += chunk.length;
      if (totalLength > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

/**
 * Set security headers on every response.
 */
function setSecurityHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Validate that POST requests originate from the local dashboard.
 * Returns true if the Origin is acceptable, false otherwise.
 */
function isValidOrigin(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers['origin'];
  if (!origin) return true; // No Origin header = same-origin request (non-browser or same-page)
  const allowed = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  return allowed.includes(origin);
}

/**
 * Send a JSON response.
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
  setSecurityHeaders(res);
  res.setHeader('Cache-Control', 'no-store');
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Send an error JSON response.
 */
function sendError(res: http.ServerResponse, statusCode: number, message: string): void {
  sendJson(res, statusCode, { error: message });
}

// ── Server ─────────────────────────────────────────────────────────────────────

export async function startDashboardServer(options: DashboardServerOptions): Promise<void> {
  const { port: requestedPort, assetsDir, token, open } = options;

  const stateManager = getStateManager();
  const resolvedAssetsDir = path.resolve(assetsDir);

  // ── Cached data ──────────────────────────────────────────────────────────
  // Start immediately with state.json data (written by the daily check that
  // precedes this server launch). A background GitHub fetch refreshes the
  // cache after the port is bound, so the startup poller sees us in time.
  let cachedDigest: DailyDigest = stateManager.getState().lastDigest!;
  let cachedCommentedIssues: CommentedIssue[] = [];

  if (!cachedDigest) {
    throw new Error(
      'No dashboard data available. Run the daily check first: GITHUB_TOKEN=$(gh auth token) npm start -- daily',
    );
  }

  // ── Build cached JSON response ───────────────────────────────────────────
  let cachedJsonData: DashboardJsonData;
  try {
    cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
  } catch (error) {
    throw new Error(
      `Failed to build dashboard data: ${errorMessage(error)}. State data may be corrupted — try running: daily --json`,
      { cause: error },
    );
  }

  // ── Rate limiters ───────────────────────────────────────────────────────
  const dataLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 }); // 30/min
  const actionLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 }); // 10/min
  const refreshLimiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 }); // 2/min

  // ── Request handler ──────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    try {
      // ── API routes ─────────────────────────────────────────────────────
      if (url === '/api/data' && method === 'GET') {
        const check = dataLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        sendJson(res, 200, cachedJsonData);
        return;
      }

      if (url === '/api/action' && method === 'POST') {
        if (!isValidOrigin(req, actualPort)) {
          sendError(res, 403, 'Invalid origin');
          return;
        }
        const check = actionLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        await handleAction(req, res);
        return;
      }

      if (url === '/api/refresh' && method === 'POST') {
        if (!isValidOrigin(req, actualPort)) {
          sendError(res, 403, 'Invalid origin');
          return;
        }
        const check = refreshLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        await handleRefresh(req, res);
        return;
      }

      // ── Static file serving ────────────────────────────────────────────
      if (method === 'GET') {
        serveStaticFile(url, res);
        return;
      }

      sendError(res, 405, 'Method not allowed');
    } catch (error) {
      warn(MODULE, `Unhandled request error: ${method} ${url} ${errorMessage(error)}`);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    }
  });

  server.requestTimeout = REQUEST_TIMEOUT_MS;

  // ── POST /api/action handler ─────────────────────────────────────────────
  async function handleAction(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: ActionRequest;
    try {
      const raw = await readBody(req);
      body = JSON.parse(raw) as ActionRequest;
    } catch (e) {
      const isBodyTooLarge = e instanceof Error && e.message === 'Body too large';
      sendError(res, isBodyTooLarge ? 413 : 400, isBodyTooLarge ? 'Request body too large' : 'Invalid JSON body');
      return;
    }

    if (!body.action || !VALID_ACTIONS.has(body.action)) {
      sendError(res, 400, `Invalid action. Must be one of: ${[...VALID_ACTIONS].join(', ')}`);
      return;
    }

    if (!body.url || typeof body.url !== 'string') {
      sendError(res, 400, 'Missing or invalid "url" field');
      return;
    }

    // Validate URL format — all actions are PR-only now.
    try {
      validateUrl(body.url);
      validateGitHubUrl(body.url, PR_URL_PATTERN, 'PR');
    } catch (err) {
      if (err instanceof ValidationError) {
        sendError(res, 400, err.message);
      } else {
        warn(MODULE, `Unexpected error during URL validation: ${errorMessage(err)}`);
        sendError(res, 400, 'Invalid URL');
      }
      return;
    }

    // Validate override_status-specific fields
    if (body.action === 'override_status') {
      if (!body.status || (body.status !== 'needs_addressing' && body.status !== 'waiting_on_maintainer')) {
        sendError(
          res,
          400,
          'override_status requires a valid "status" field (needs_addressing or waiting_on_maintainer)',
        );
        return;
      }
    }

    try {
      switch (body.action) {
        case 'shelve':
          stateManager.shelvePR(body.url);
          break;
        case 'unshelve':
          stateManager.unshelvePR(body.url);
          break;
        case 'override_status': {
          // body.status is validated above — the early return ensures it's defined here
          const overrideStatus = body.status as 'needs_addressing' | 'waiting_on_maintainer';
          // Find the PR to get its current updatedAt for auto-clear tracking
          const targetPR = (cachedDigest?.openPRs || []).find((pr) => pr.url === body.url);
          const lastActivityAt = targetPR?.updatedAt || new Date().toISOString();
          stateManager.setStatusOverride(body.url, overrideStatus, lastActivityAt);
          break;
        }
      }
      stateManager.save();
    } catch (error) {
      warn(MODULE, `Action failed: ${body.action} ${body.url} ${errorMessage(error)}`);
      sendError(res, 500, 'Action failed');
      return;
    }

    // Rebuild dashboard data from cached digest + updated state
    cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);

    sendJson(res, 200, cachedJsonData);
  }

  // ── POST /api/refresh handler ────────────────────────────────────────────
  async function handleRefresh(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const currentToken = token || getGitHubToken();
    if (!currentToken) {
      sendError(res, 401, 'No GitHub token available. Cannot refresh data.');
      return;
    }

    try {
      warn(MODULE, 'Refreshing dashboard data from GitHub...');
      const result = await fetchDashboardData(currentToken);
      cachedDigest = result.digest;
      cachedCommentedIssues = result.commentedIssues;
      cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
      sendJson(res, 200, cachedJsonData);
    } catch (error) {
      warn(MODULE, `Dashboard refresh failed: ${errorMessage(error)}`);
      sendError(res, 500, 'Refresh failed');
    }
  }

  // ── Static file serving ──────────────────────────────────────────────────
  function serveStaticFile(requestUrl: string, res: http.ServerResponse): void {
    // Decode URL, handling malformed percent-encoding
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(requestUrl.split('?')[0]);
    } catch (_err) {
      warn(MODULE, `Malformed URL received: ${requestUrl}`);
      sendError(res, 400, 'Malformed URL');
      return;
    }

    // Security: reject paths with parent directory references
    if (urlPath.includes('..')) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    // Resolve the file path from sanitized URL
    const relativePath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    let filePath = path.join(resolvedAssetsDir, relativePath);

    // Belt-and-suspenders: ensure resolved path is within assets directory
    if (!filePath.startsWith(resolvedAssetsDir + path.sep) && filePath !== resolvedAssetsDir) {
      sendError(res, 403, 'Forbidden');
      return;
    }

    // If file doesn't exist or is a directory, serve index.html for SPA routing
    try {
      const stat = fs.statSync(filePath);
      if (stat.isDirectory()) {
        filePath = path.join(resolvedAssetsDir, 'index.html');
      }
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        filePath = path.join(resolvedAssetsDir, 'index.html');
      } else {
        warn(MODULE, `Failed to stat file: ${filePath}`);
        sendError(res, 500, 'Internal server error');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      setSecurityHeaders(res);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(content);
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        sendError(res, 404, 'Not found');
      } else {
        warn(MODULE, `Failed to serve static file: ${filePath}`);
        sendError(res, 500, 'Failed to read file');
      }
    }
  }

  // ── Start server with port retry ─────────────────────────────────────────
  const MAX_PORT_ATTEMPTS = 10;
  let actualPort = requestedPort;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(actualPort, '127.0.0.1', () => resolve());
      });
      // Success — break out of retry loop
      break;
    } catch (err) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr.code === 'EADDRINUSE' && attempt < MAX_PORT_ATTEMPTS - 1) {
        warn(MODULE, `Port ${actualPort} is in use, trying ${actualPort + 1}...`);
        actualPort++;
        continue;
      }
      throw new Error(`Failed to start server: ${nodeErr.message}`, { cause: err });
    }
  }

  // Write PID file so other processes can detect this running server
  writeDashboardServerInfo({
    pid: process.pid,
    port: actualPort,
    startedAt: new Date().toISOString(),
    version: getCLIVersion(),
  });

  const serverUrl = `http://localhost:${actualPort}`;
  warn(MODULE, `Dashboard server running at ${serverUrl}`);

  // ── Background refresh ─────────────────────────────────────────────────
  // Port is bound and PID file written — now fetch fresh data from GitHub
  // so subsequent /api/data requests get live data instead of cached state.
  if (token) {
    fetchDashboardData(token)
      .then((result) => {
        cachedDigest = result.digest;
        cachedCommentedIssues = result.commentedIssues;
        cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
        warn(MODULE, 'Background data refresh complete');
      })
      .catch((error) => {
        warn(MODULE, `Background data refresh failed (serving cached data): ${errorMessage(error)}`);
      });
  }

  // ── Open browser ─────────────────────────────────────────────────────────
  if (open) {
    openInBrowser(serverUrl);
  }

  // ── Clean shutdown ───────────────────────────────────────────────────────
  const shutdown = () => {
    warn(MODULE, 'Shutting down dashboard server...');
    removeDashboardServerInfo();
    server.close(() => {
      process.exit(0);
    });
    // Force exit after 3 seconds if server doesn't close cleanly
    setTimeout(() => process.exit(0), 3000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/**
 * Dashboard HTTP server.
 * Serves the Preact SPA from packages/dashboard/dist/ and provides API endpoints
 * for live data fetching and state mutations (PR state transitions, issue dismiss).
 *
 * Uses Node's built-in http module — no Express/Fastify.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { getStateManager, getGitHubToken, getCLIVersion, applyStatusOverrides } from '../core/index.js';
import { errorMessage, ValidationError } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { validateUrl, validateGitHubUrl, PR_URL_PATTERN, ISSUE_URL_PATTERN } from './validation.js';
import type { MoveTarget } from './move.js';
import {
  fetchDashboardData,
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  buildDashboardStats,
  storedToMergedPRs,
  storedToClosedPRs,
  type DashboardJsonData,
  type ActionRequest,
} from './dashboard-data.js';
import { openInBrowser, detectIssueList } from './startup.js';
import { parseIssueList, type ParseIssueListOutput } from './parse-list.js';
import { writeDashboardServerInfo, removeDashboardServerInfo } from './dashboard-process.js';
import { RateLimiter } from './rate-limiter.js';
import {
  isBelowMinStars,
  type DailyDigest,
  type AgentState,
  type CommentedIssue,
  type CommentedIssueWithResponse,
  type MergedPR,
  type ClosedPR,
  type RepoMetadataEntry,
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

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ACTIONS: Set<ActionRequest['action']> = new Set(['move', 'dismiss_issue_response']);

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

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Read and parse the vetted issue list file (non-fatal on failure).
 */
function readVettedIssues(): ParseIssueListOutput | null {
  try {
    const info = detectIssueList();
    if (!info) return null;
    const content = fs.readFileSync(info.path, 'utf8');
    return parseIssueList(content);
  } catch (error) {
    warn(MODULE, `Failed to read vetted issue list: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Get the mtime of the vetted issue list file in ms, or null if unknown.
 * Used to detect external edits and invalidate the cached dashboard payload.
 */
function getIssueListMtimeMs(): number | null {
  try {
    const info = detectIssueList();
    if (!info) return null;
    return fs.statSync(info.path).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Build the JSON payload that the SPA expects from GET /api/data.
 *
 * Exported for unit testing of response-shape concerns that the full
 * handler harness can't reach (it bakes a stale cachedDigest at server
 * start-up, so tests that need a specific digest should call this directly).
 */
export function buildDashboardJson(
  digest: DailyDigest,
  state: Readonly<AgentState>,
  commentedIssues: CommentedIssue[],
  allMergedPRs?: MergedPR[],
  allClosedPRs?: ClosedPR[],
  partialFailures?: string[],
): DashboardJsonData {
  const prsByRepo = computePRsByRepo(digest, state);
  const topRepos = computeTopRepos(prsByRepo);
  const { monthlyMerged, monthlyOpened, monthlyClosed } = getMonthlyData(state);
  // Derive from state if not provided (e.g. initial load from cached state)
  const mergedPRs = allMergedPRs ?? storedToMergedPRs(getStateManager().getMergedPRs());
  const closedPRs = allClosedPRs ?? storedToClosedPRs(getStateManager().getClosedPRs());
  // Filter out PRs from repos below the minStars threshold
  const minStars = state.config.minStars ?? 50;
  const repoScores = state.repoScores || {};
  const isAboveMinStars = (pr: { repo: string }): boolean =>
    !isBelowMinStars(repoScores[pr.repo]?.stargazersCount, minStars);
  const filteredMergedPRs = mergedPRs.filter(isAboveMinStars);
  const filteredClosedPRs = closedPRs.filter(isAboveMinStars);
  const stats = buildDashboardStats(digest, state, filteredMergedPRs.length, filteredClosedPRs.length);
  const dismissedIssues = state.config.dismissedIssues || {};
  const issueResponses = commentedIssues.filter(
    (i): i is CommentedIssueWithResponse => i.status === 'new_response' && !(i.url in dismissedIssues),
  );

  // Build repo metadata map from repoScores — omit repos without stars or language to avoid empty entries
  const repoMetadata: Record<string, RepoMetadataEntry> = {};
  for (const [repo, score] of Object.entries(repoScores)) {
    if (score.stargazersCount !== undefined || score.language !== undefined) {
      repoMetadata[repo] = { stars: score.stargazersCount, language: score.language };
    }
  }

  const vettedIssues = readVettedIssues();
  if (vettedIssues) {
    stats.availableIssues = vettedIssues.availableCount;
  }

  return {
    stats,
    prsByRepo,
    topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
    monthlyMerged,
    monthlyOpened,
    monthlyClosed,
    activePRs: applyStatusOverrides(digest.openPRs || [], state),
    // Source of truth is digest.shelvedPRs (union of explicitly-shelved URLs
    // and dormant-non-addressing PRs auto-shelved for display). Returning
    // only state.config.shelvedPRUrls would under-count and desync from
    // stats.shelvedPRs, which is already derived from digest.shelvedPRs. (#981)
    shelvedPRUrls: (digest.shelvedPRs || []).map((ref) => ref.url),
    recentlyMergedPRs: digest.recentlyMergedPRs || [],
    recentlyClosedPRs: digest.recentlyClosedPRs || [],
    autoUnshelvedPRs: digest.autoUnshelvedPRs || [],
    commentedIssues,
    issueResponses,
    allMergedPRs: filteredMergedPRs,
    allClosedPRs: filteredClosedPRs,
    repoMetadata,
    vettedIssues,
    partialFailures: partialFailures && partialFailures.length > 0 ? partialFailures : undefined,
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
      if (!aborted) resolve(Buffer.concat(chunks).toString('utf8'));
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
  // worker-src: canvas-confetti generates its animation worker as a Blob and
  // loads it via a blob: URL. Without this directive the browser falls back
  // to script-src, which doesn't list blob:, and the celebrate button fails
  // silently. Scoped to workers only — safer than widening script-src.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:",
  );
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
}

/**
 * Valid Host header values for this server — used for both Origin checks
 * (strips the `http://` scheme) and Host-header DNS-rebinding checks.
 */
function allowedHostsFor(port: number): string[] {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `oss.localhost:${port}`];
}

/**
 * Validate that POST requests originate from the local dashboard.
 *
 * Returns true only if the `Origin` header is present AND matches the
 * loopback allow-list. A missing `Origin` now returns false — previously it
 * returned true to allow non-browser same-origin calls, but that let any
 * local process (curl, scripts) POST to /api/action and /api/refresh. See
 * issue #1031.
 */
function isValidOrigin(req: http.IncomingMessage, port: number): boolean {
  const origin = req.headers['origin'];
  if (typeof origin !== 'string') return false;
  const allowed = allowedHostsFor(port).map((h) => `http://${h}`);
  return allowed.includes(origin);
}

/**
 * Validate the `Host` header against the loopback allow-list.
 *
 * Blocks DNS-rebinding attacks: a victim browser resolves an attacker domain
 * to 127.0.0.1, reaches this server, and the `Host` header carries the
 * attacker's hostname. Rejecting non-loopback Host headers closes that path
 * for both GET /api/data (data exfil) and the POST endpoints.
 */
function isValidHost(req: http.IncomingMessage, port: number): boolean {
  const host = req.headers['host'];
  if (typeof host !== 'string') return false;
  return allowedHostsFor(port).includes(host);
}

/**
 * Validate the CSRF token header for state-mutating POST endpoints.
 */
function isValidCsrfToken(req: http.IncomingMessage, expected: string): boolean {
  const token = req.headers['x-csrf-token'];
  if (typeof token !== 'string' || token.length !== expected.length) return false;
  // Constant-time comparison to avoid leaking token bytes via timing.
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch {
    return false;
  }
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

  // ── CSRF token ──────────────────────────────────────────────────────────
  // Fresh per server-start. Exposed to the SPA via X-CSRF-Token on every
  // /api/data response; required back on X-CSRF-Token for state-mutating
  // POST endpoints. Prevents local non-browser processes (curl, scripts)
  // from invoking /api/action and /api/refresh even when they guess the
  // Origin header — the token itself is only reachable by calling
  // /api/data, which enforces the Host check.
  const csrfToken = crypto.randomBytes(32).toString('hex');

  // ── Cached data ──────────────────────────────────────────────────────────
  // Start immediately with state.json data (written by the daily check that
  // precedes this server launch). A background GitHub fetch refreshes the
  // cache after the port is bound, so the startup poller sees us in time.
  let cachedDigest: DailyDigest = stateManager.getState().lastDigest!;
  let cachedCommentedIssues: CommentedIssue[] = [];
  // Persist the last-known partialFailures across rebuild requests (#1035).
  // Cleared only when a fresh fetchDashboardData returns zero failures;
  // re-threaded into every buildDashboardJson call so the SPA banner does
  // not disappear when /api/data rebuilds after a state change or after a
  // POST /api/action completes.
  let cachedPartialFailures: string[] | undefined = undefined;
  // Tracks the last background-refresh failure so /api/data can surface
  // staleness to the SPA via the X-Dashboard-Stale header (#1205). Cleared
  // when a refresh succeeds. Without this, token expiry / GitHub outage
  // produces silent stale data hours old with no client-visible signal.
  let lastBackgroundRefreshError: string | null = null;

  if (!cachedDigest) {
    throw new Error(
      'No dashboard data available. Run the daily check first: GITHUB_TOKEN=$(gh auth token) npm start -- daily',
    );
  }

  // ── Build cached JSON response ───────────────────────────────────────────
  let cachedJsonData: DashboardJsonData;
  let cachedIssueListMtimeMs = getIssueListMtimeMs();
  try {
    cachedJsonData = buildDashboardJson(
      cachedDigest,
      stateManager.getState(),
      cachedCommentedIssues,
      undefined,
      undefined,
      cachedPartialFailures,
    );
  } catch (error) {
    throw new Error(
      `Failed to build dashboard data: ${errorMessage(error)}. State data may be corrupted — try running: daily --json`,
      { cause: error },
    );
  }

  // ── Rate limiters ───────────────────────────────────────────────────────
  const dataLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60_000 }); // 30/min
  const actionLimiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 }); // 10/min
  const refreshLimiter = new RateLimiter({ maxRequests: 6, windowMs: 60_000 }); // 6/min

  // ── Request handler ──────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    try {
      // ── Host-header check (DNS-rebinding defense) ──────────────────────
      // Applied to every request including static files so a rebound
      // attacker hostname cannot read SPA assets or API responses.
      if (url.startsWith('/api/') && !isValidHost(req, actualPort)) {
        sendError(res, 403, 'Invalid host');
        return;
      }

      // ── API routes ─────────────────────────────────────────────────────
      if (url === '/api/data' && method === 'GET') {
        const check = dataLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        // Expose the CSRF token to the SPA on every data fetch so the client
        // can attach it on subsequent POSTs. Fresh fetch → fresh token view.
        res.setHeader('X-CSRF-Token', csrfToken);
        // Re-read state if modified externally (file mtime for local, Gist API for Gist mode)
        let stateChanged = false;
        if (stateManager.isGistMode()) {
          stateChanged = await stateManager.refreshFromGist();
        } else {
          stateChanged = stateManager.reloadIfChanged();
        }
        // Also rebuild when the vetted issue list file was edited outside this server (#924)
        const currentIssueListMtimeMs = getIssueListMtimeMs();
        const issueListChanged = currentIssueListMtimeMs !== cachedIssueListMtimeMs;
        if (stateChanged || issueListChanged) {
          try {
            cachedJsonData = buildDashboardJson(
              cachedDigest,
              stateManager.getState(),
              cachedCommentedIssues,
              undefined,
              undefined,
              cachedPartialFailures,
            );
            cachedIssueListMtimeMs = currentIssueListMtimeMs;
          } catch (error) {
            warn(MODULE, `Failed to rebuild dashboard data after state reload: ${errorMessage(error)}`);
            // Serve previous cachedJsonData rather than returning 500.
            // Signal staleness via response header so clients can detect the degraded mode (#994).
            res.setHeader('X-Dashboard-Stale', '1');
          }
        }
        // Surface staleness from a failed background refresh too (#1205) so
        // token expiry / GitHub outage produces a client-visible signal
        // rather than silent stale data. Only set the header when a failure
        // is recorded — successful refreshes clear it.
        if (lastBackgroundRefreshError !== null) {
          res.setHeader('X-Dashboard-Stale', '1');
          res.setHeader('X-Dashboard-Stale-Reason', `background-refresh-failed: ${lastBackgroundRefreshError}`);
        }
        sendJson(res, 200, cachedJsonData);
        return;
      }

      if (url === '/api/action' && method === 'POST') {
        // Rate limit BEFORE auth checks so a local attacker cannot flood
        // invalid-CSRF requests without consuming their quota. The Host
        // check above already ran; still need Origin + CSRF below.
        const check = actionLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        if (!isValidOrigin(req, actualPort)) {
          sendError(res, 403, 'Invalid origin');
          return;
        }
        if (!isValidCsrfToken(req, csrfToken)) {
          sendError(res, 403, 'Missing or invalid CSRF token');
          return;
        }
        await handleAction(req, res);
        return;
      }

      if (url === '/api/refresh' && method === 'POST') {
        const check = refreshLimiter.check();
        if (!check.allowed) {
          res.setHeader('Retry-After', String(check.retryAfterSeconds));
          sendError(res, 429, 'Too many requests');
          return;
        }
        if (!isValidOrigin(req, actualPort)) {
          sendError(res, 403, 'Invalid origin');
          return;
        }
        if (!isValidCsrfToken(req, csrfToken)) {
          sendError(res, 403, 'Missing or invalid CSRF token');
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
    // Reload state before mutating to avoid overwriting external CLI changes
    if (stateManager.isGistMode()) {
      await stateManager.refreshFromGist();
    } else {
      stateManager.reloadIfChanged();
    }

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

    // Validate URL format — move is PR-only, dismiss_issue_response is issue-only.
    const isDismiss = body.action === 'dismiss_issue_response';
    try {
      validateUrl(body.url);
      validateGitHubUrl(body.url, isDismiss ? ISSUE_URL_PATTERN : PR_URL_PATTERN, isDismiss ? 'issue' : 'PR');
    } catch (err) {
      if (err instanceof ValidationError) {
        sendError(res, 400, err.message);
      } else {
        warn(MODULE, `Unexpected error during URL validation: ${errorMessage(err)}`);
        sendError(res, 400, 'Invalid URL');
      }
      return;
    }

    try {
      if (body.action === 'move') {
        const { VALID_TARGETS, runMove } = await import('./move.js');
        if (!body.target || !VALID_TARGETS.includes(body.target as MoveTarget)) {
          sendError(res, 400, `move requires a valid "target" field (${VALID_TARGETS.join(', ')})`);
          return;
        }
        await runMove({ prUrl: body.url, target: body.target });
      } else {
        // dismiss_issue_response
        stateManager.dismissIssue(body.url, new Date().toISOString());
      }
    } catch (error) {
      warn(MODULE, `Action failed: ${body.action} ${body.url} ${errorMessage(error)}`);
      sendError(res, 500, 'Action failed');
      return;
    }

    // Rebuild dashboard data from cached digest + updated state. Persist
    // the last-known partialFailures across action rebuilds (#1035) so the
    // SPA banner survives user interactions until the next successful
    // refresh clears it.
    cachedJsonData = buildDashboardJson(
      cachedDigest,
      stateManager.getState(),
      cachedCommentedIssues,
      undefined,
      undefined,
      cachedPartialFailures,
    );
    cachedIssueListMtimeMs = getIssueListMtimeMs();

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
      if (stateManager.isGistMode()) {
        await stateManager.refreshFromGist();
      } else {
        stateManager.reloadIfChanged();
      }
      warn(MODULE, 'Refreshing dashboard data from GitHub...');
      const result = await fetchDashboardData(currentToken);
      cachedDigest = result.digest;
      cachedCommentedIssues = result.commentedIssues;
      // Update the persistent banner signal — clear on a clean refresh,
      // set when one or more sub-fetches degraded. See #1035.
      cachedPartialFailures = result.partialFailures.length > 0 ? result.partialFailures : undefined;
      cachedJsonData = buildDashboardJson(
        cachedDigest,
        stateManager.getState(),
        cachedCommentedIssues,
        result.allMergedPRs,
        result.allClosedPRs,
        cachedPartialFailures,
      );
      cachedIssueListMtimeMs = getIssueListMtimeMs();
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

  const serverUrl = `http://oss.localhost:${actualPort}`;
  warn(MODULE, `Dashboard server running at ${serverUrl} (also: http://localhost:${actualPort})`);

  // ── Background refresh ─────────────────────────────────────────────────
  // Port is bound and PID file written — now fetch fresh data from GitHub
  // so subsequent /api/data requests get live data instead of cached state.
  if (token) {
    fetchDashboardData(token)
      .then(async (result) => {
        if (stateManager.isGistMode()) {
          await stateManager.refreshFromGist();
        } else {
          stateManager.reloadIfChanged();
        }
        cachedDigest = result.digest;
        cachedCommentedIssues = result.commentedIssues;
        cachedPartialFailures = result.partialFailures.length > 0 ? result.partialFailures : undefined;
        cachedJsonData = buildDashboardJson(
          cachedDigest,
          stateManager.getState(),
          cachedCommentedIssues,
          result.allMergedPRs,
          result.allClosedPRs,
          cachedPartialFailures,
        );
        cachedIssueListMtimeMs = getIssueListMtimeMs();
        // Successful refresh clears any prior failure signal (#1205).
        lastBackgroundRefreshError = null;
        warn(MODULE, 'Background data refresh complete');
        return;
      })
      .catch((error) => {
        // Capture so /api/data can surface staleness via X-Dashboard-Stale
        // header — previously the catch only logged to stderr (#1205).
        lastBackgroundRefreshError = errorMessage(error);
        warn(MODULE, `Background data refresh failed (serving cached data): ${lastBackgroundRefreshError}`);
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

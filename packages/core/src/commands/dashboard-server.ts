/**
 * Dashboard HTTP server.
 * Serves the Preact SPA from packages/dashboard/dist/ and provides API endpoints
 * for live data fetching and state mutations (shelve, snooze, etc.).
 *
 * Uses Node's built-in http module — no Express/Fastify.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { getStateManager, getGitHubToken, getDataDir } from '../core/index.js';
import { errorMessage, ValidationError } from '../core/errors.js';
import { validateUrl, validateGitHubUrl, validateMessage, PR_URL_PATTERN } from './validation.js';
import { fetchDashboardData, computePRsByRepo, computeTopRepos, getMonthlyData } from './dashboard-data.js';
import { buildDashboardStats, type DashboardStats } from './dashboard-templates.js';
import type { DailyDigest, AgentState, CommentedIssue, CommentedIssueWithResponse, FetchedPR } from '../core/types.js';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DashboardServerOptions {
  port: number;
  assetsDir: string;
  token: string | null;
  open: boolean;
}

export interface DashboardServerInfo {
  pid: number;
  port: number;
  startedAt: string;
}

interface DashboardJsonData {
  stats: DashboardStats;
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  monthlyMerged: Record<string, number>;
  activePRs: FetchedPR[];
  shelvedPRUrls: string[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
  offline?: boolean;
  lastUpdated?: string;
}

interface ActionRequest {
  action: 'shelve' | 'unshelve' | 'snooze' | 'unsnooze';
  url: string;
  reason?: string;
  days?: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const VALID_ACTIONS: Set<ActionRequest['action']> = new Set(['shelve', 'unshelve', 'snooze', 'unsnooze']);

const MAX_BODY_BYTES = 10_240;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── PID File Management ──────────────────────────────────────────────────────

export function getDashboardPidPath(): string {
  return path.join(getDataDir(), 'dashboard-server.pid');
}

export function writeDashboardServerInfo(info: DashboardServerInfo): void {
  fs.writeFileSync(getDashboardPidPath(), JSON.stringify(info), { mode: 0o600 });
}

export function readDashboardServerInfo(): DashboardServerInfo | null {
  try {
    const content = fs.readFileSync(getDashboardPidPath(), 'utf-8');
    const parsed = JSON.parse(content);
    if (
      typeof parsed !== 'object' || parsed === null ||
      typeof parsed.pid !== 'number' || typeof parsed.port !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      console.error('[DASHBOARD] PID file has invalid structure, ignoring');
      return null;
    }
    return parsed as DashboardServerInfo;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[DASHBOARD] Failed to read PID file: ${(err as Error).message}`);
    }
    return null;
  }
}

export function removeDashboardServerInfo(): void {
  try {
    fs.unlinkSync(getDashboardPidPath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(`[DASHBOARD] Failed to remove PID file: ${(err as Error).message}`);
    }
  }
}

// ── Health Probe ─────────────────────────────────────────────────────────────

export function isDashboardServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/data`, { timeout: 2000 }, (res) => {
      // Consume response data to free up memory
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

export async function findRunningDashboardServer(): Promise<{ port: number; url: string } | null> {
  const info = readDashboardServerInfo();
  if (!info) return null;

  // Check if process is alive (signal 0 = existence check only)
  try {
    process.kill(info.pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ESRCH' && code !== 'EPERM') {
      console.error(`[DASHBOARD] Unexpected error checking PID ${info.pid}: ${(err as Error).message}`);
    }
    // ESRCH = no process at that PID; EPERM = PID recycled to another user's process
    // Either way, our dashboard server is no longer running — clean up stale PID file
    removeDashboardServerInfo();
    return null;
  }

  // Process exists — verify it's actually our server via HTTP probe
  if (await isDashboardServerRunning(info.port)) {
    return { port: info.port, url: `http://localhost:${info.port}` };
  }

  // Process exists but not responding on expected port — stale
  removeDashboardServerInfo();
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Build the JSON payload that the SPA expects from GET /api/data.
 * Same shape as the existing `dashboard --json` output.
 */
function buildDashboardJson(
  digest: DailyDigest,
  state: Readonly<AgentState>,
  commentedIssues: CommentedIssue[],
): DashboardJsonData {
  const prsByRepo = computePRsByRepo(digest, state);
  const topRepos = computeTopRepos(prsByRepo);
  const { monthlyMerged } = getMonthlyData(state);
  const stats = buildDashboardStats(digest, state);
  const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');

  return {
    stats,
    prsByRepo,
    topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
    monthlyMerged,
    activePRs: digest.openPRs || [],
    shelvedPRUrls: state.config.shelvedPRUrls || [],
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
 * Send a JSON response.
 */
function sendJson(res: http.ServerResponse, statusCode: number, data: unknown): void {
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
  let cachedDigest: DailyDigest | undefined;
  let cachedCommentedIssues: CommentedIssue[] = [];

  // Fetch initial data
  if (token) {
    try {
      console.error('Fetching dashboard data from GitHub...');
      const result = await fetchDashboardData(token);
      cachedDigest = result.digest;
      cachedCommentedIssues = result.commentedIssues;
    } catch (error) {
      console.error('Failed to fetch data from GitHub:', error);
      console.error('Falling back to cached data...');
      cachedDigest = stateManager.getState().lastDigest;
    }
  } else {
    cachedDigest = stateManager.getState().lastDigest;
  }

  if (!cachedDigest) {
    console.error('No dashboard data available. Run the daily check first:');
    console.error('  GITHUB_TOKEN=$(gh auth token) npm start -- daily');
    process.exit(1);
  }

  // ── Build cached JSON response ───────────────────────────────────────────
  let cachedJsonData: DashboardJsonData;
  try {
    cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
  } catch (error) {
    console.error('Failed to build dashboard data from cached digest:', error);
    console.error('Your state data may be corrupted. Try running: daily --json');
    process.exit(1);
  }

  // ── Request handler ──────────────────────────────────────────────────────
  const server = http.createServer(async (req, res) => {
    const method = req.method || 'GET';
    const url = req.url || '/';

    try {
      // ── API routes ─────────────────────────────────────────────────────
      if (url === '/api/data' && method === 'GET') {
        sendJson(res, 200, cachedJsonData);
        return;
      }

      if (url === '/api/action' && method === 'POST') {
        await handleAction(req, res);
        return;
      }

      if (url === '/api/refresh' && method === 'POST') {
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
      console.error('Unhandled request error:', method, url, error);
      if (!res.headersSent) {
        sendError(res, 500, 'Internal server error');
      }
    }
  });

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

    // Validate URL format — same checks as CLI commands
    try {
      validateUrl(body.url);
      validateGitHubUrl(body.url, PR_URL_PATTERN, 'PR');
    } catch (err) {
      if (err instanceof ValidationError) {
        sendError(res, 400, err.message);
      } else {
        console.error('Unexpected error during URL validation:', err);
        sendError(res, 400, 'Invalid URL');
      }
      return;
    }

    // Validate snooze-specific fields
    if (body.action === 'snooze') {
      const days = body.days ?? 7;
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        sendError(res, 400, 'Snooze days must be a positive finite number');
        return;
      }
      if (body.reason !== undefined) {
        try {
          validateMessage(String(body.reason));
        } catch (err) {
          if (err instanceof ValidationError) {
            sendError(res, 400, err.message);
          } else {
            console.error('Unexpected error during message validation:', err);
            sendError(res, 400, 'Invalid reason');
          }
          return;
        }
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
        case 'snooze':
          stateManager.snoozePR(body.url, body.reason || 'Snoozed via dashboard', body.days ?? 7);
          break;
        case 'unsnooze':
          stateManager.unsnoozePR(body.url);
          break;
      }
      stateManager.save();
    } catch (error) {
      console.error('Action failed:', body.action, body.url, error);
      sendError(res, 500, `Action failed: ${errorMessage(error)}`);
      return;
    }

    // Rebuild dashboard data from cached digest + updated state
    if (cachedDigest) {
      cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
    }

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
      console.error('Refreshing dashboard data from GitHub...');
      const result = await fetchDashboardData(currentToken);
      cachedDigest = result.digest;
      cachedCommentedIssues = result.commentedIssues;
      cachedJsonData = buildDashboardJson(cachedDigest, stateManager.getState(), cachedCommentedIssues);
      sendJson(res, 200, cachedJsonData);
    } catch (error) {
      console.error('Dashboard refresh failed:', error);
      sendError(res, 500, `Refresh failed: ${errorMessage(error)}`);
    }
  }

  // ── Static file serving ──────────────────────────────────────────────────
  function serveStaticFile(requestUrl: string, res: http.ServerResponse): void {
    // Decode URL, handling malformed percent-encoding
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(requestUrl.split('?')[0]);
    } catch (err) {
      console.error('Malformed URL received:', requestUrl, err);
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
        console.error('Failed to stat file:', filePath, err);
        sendError(res, 500, 'Internal server error');
        return;
      }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    try {
      const content = fs.readFileSync(filePath);
      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': content.length,
      });
      res.end(content);
    } catch (error) {
      const nodeErr = error as NodeJS.ErrnoException;
      if (nodeErr.code === 'ENOENT') {
        sendError(res, 404, 'Not found');
      } else {
        console.error('Failed to serve static file:', filePath, error);
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
        console.error(`Port ${actualPort} is in use, trying ${actualPort + 1}...`);
        actualPort++;
        continue;
      }
      console.error(`Failed to start server: ${nodeErr.message}`);
      process.exit(1);
    }
  }

  // Write PID file so other processes can detect this running server
  writeDashboardServerInfo({ pid: process.pid, port: actualPort, startedAt: new Date().toISOString() });

  const serverUrl = `http://localhost:${actualPort}`;
  console.error(`Dashboard server running at ${serverUrl}`);

  // ── Open browser ─────────────────────────────────────────────────────────
  if (open) {
    const { execFile } = await import('child_process');
    let openCmd: string;
    let args: string[];
    switch (process.platform) {
      case 'darwin':
        openCmd = 'open';
        args = [serverUrl];
        break;
      case 'win32':
        openCmd = 'cmd';
        args = ['/c', 'start', '', serverUrl];
        break;
      default:
        openCmd = 'xdg-open';
        args = [serverUrl];
        break;
    }

    execFile(openCmd, args, (error) => {
      if (error) {
        console.error('Failed to open browser:', error.message);
        console.error(`Open manually: ${serverUrl}`);
      }
    });
  }

  // ── Clean shutdown ───────────────────────────────────────────────────────
  const shutdown = () => {
    console.error('\nShutting down dashboard server...');
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

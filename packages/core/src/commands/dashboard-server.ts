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
import {
  getStateManager,
  getGitHubToken,
  getCLIVersion,
  applyStatusOverrides,
  classifyAttentionBucket,
  maybeCheckpoint,
  ensureGistPersistence,
} from '../core/index.js';
import {
  errorMessage,
  ValidationError,
  ConcurrencyError,
  ConfigurationError,
  GistConcurrencyError,
} from '../core/errors.js';
import { warn } from '../core/logger.js';
import { validateUrl, validateGitHubUrl, PR_URL_PATTERN, ISSUE_URL_PATTERN } from './validation.js';
import type { MoveTarget } from './move.js';
import {
  fetchDashboardData,
  computePRsByRepo,
  computeTopRepos,
  getMonthlyData,
  buildDashboardStats,
  reconcileShelvePartition,
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
 *
 * @param failures - Optional collector (#1448): a read/parse failure pushes a
 *   label so the SPA's partialFailures banner shows the panel is degraded
 *   rather than silently empty. "No list detected" is not a failure and
 *   pushes nothing.
 */
function readVettedIssues(failures?: string[]): ParseIssueListOutput | null {
  try {
    const info = detectIssueList();
    if (!info) return null;
    const content = fs.readFileSync(info.path, 'utf8');
    return parseIssueList(content);
  } catch (error) {
    warn(MODULE, `Failed to read vetted issue list: ${errorMessage(error)}`);
    failures?.push('read vetted issue list');
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
  // Collect build-local failures (#1448) alongside the caller-provided ones
  // so degradations detected during THIS build (vetted-list read failure,
  // status-override application failure) reach the SPA's partialFailures
  // banner instead of living only in stderr.
  const buildFailures: string[] = [...(partialFailures ?? [])];
  // Apply status overrides ONCE, before the shelve partition is derived, so
  // the dashboard partitions on the same post-override status the CLI
  // partitions on (#1416). This also covers overrides set AFTER the digest
  // was cached (a dashboard move stores an override; the action path rebuilds
  // from the cached digest). Work on a copy — the caller's cached digest must
  // not accumulate per-request derivations.
  const overriddenDigest: DailyDigest = {
    ...digest,
    openPRs: applyStatusOverrides(digest.openPRs || [], state, buildFailures),
    summary: { ...digest.summary },
  };
  // Re-derive the shelve partition from the CURRENT state before reading it.
  // The POST /api/action path rebuilds with a cached digest whose shelvedPRs
  // predates the shelve/unshelve, so without this the SPA action appears to do
  // nothing until the next full /api/refresh.
  reconcileShelvePartition(overriddenDigest, state);
  const prsByRepo = computePRsByRepo(overriddenDigest, state);
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
  const stats = buildDashboardStats(overriddenDigest, state, filteredMergedPRs.length, filteredClosedPRs.length);
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

  // A vetted-list read failure reaches the SPA banner via buildFailures
  // instead of leaving the panel silently empty (#1448).
  const vettedIssues = readVettedIssues(buildFailures);
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
    // #1352: stamp the unified attention bucket so the SPA renders the same
    // taxonomy the CLI brief counts (single classifier, no second opinion).
    // Overrides were already applied when overriddenDigest was built — a
    // second application here would be a no-op but obscures the single
    // apply-then-partition ordering (#1416).
    activePRs: (overriddenDigest.openPRs || []).map((pr) => ({
      ...pr,
      attentionBucket: classifyAttentionBucket(pr),
    })),
    // Source of truth is digest.shelvedPRs (union of explicitly-shelved URLs
    // and dormant-non-addressing PRs auto-shelved for display). Returning
    // only state.config.shelvedPRUrls would under-count and desync from
    // stats.shelvedPRs, which is already derived from digest.shelvedPRs. (#981)
    shelvedPRUrls: (overriddenDigest.shelvedPRs || []).map((ref) => ref.url),
    recentlyMergedPRs: overriddenDigest.recentlyMergedPRs || [],
    recentlyClosedPRs: overriddenDigest.recentlyClosedPRs || [],
    autoUnshelvedPRs: overriddenDigest.autoUnshelvedPRs || [],
    commentedIssues,
    issueResponses,
    allMergedPRs: filteredMergedPRs,
    allClosedPRs: filteredClosedPRs,
    repoMetadata,
    vettedIssues,
    // Dedup: the fetch path already applies status overrides into the cached
    // partialFailures, and the rebuild applies them again above — the same
    // failing override must not appear (and be counted) twice (#1448).
    partialFailures: buildFailures.length > 0 ? [...new Set(buildFailures)] : undefined,
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

/**
 * Collapse CR/LF in a string destined for an HTTP header value — Node's
 * setHeader throws on embedded newlines, and staleness reasons are built
 * from arbitrary error messages (#1446 item 2).
 */
function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * True when an error is an optimistic-concurrency conflict on state.json
 * (local mtime CAS) or the state Gist (ETag CAS). Both carry the
 * CONCURRENCY_ERROR code and the same recovery contract: reload, re-apply,
 * save. See state-concurrency.test.ts (#1378) and errors.ts.
 */
function isConcurrencyConflict(error: unknown): boolean {
  return error instanceof ConcurrencyError || error instanceof GistConcurrencyError;
}

/**
 * Send the machine-readable 409 for a concurrency conflict (#1397).
 * `retryable: true` tells the SPA it can re-prime via GET /api/data and
 * retry the POST; `code` matches the structured code on ConcurrencyError.
 */
function sendConflict(res: http.ServerResponse): void {
  sendJson(res, 409, {
    error: 'Another process wrote state concurrently — retry the request',
    code: 'CONCURRENCY_ERROR',
    retryable: true,
  });
}

// ── Server ─────────────────────────────────────────────────────────────────────

export async function startDashboardServer(options: DashboardServerOptions): Promise<void> {
  const { port: requestedPort, assetsDir, token, open } = options;

  // `let` (#1433): a degraded gist recovery replaces the core singleton, and
  // this long-lived server must re-resolve its reference or every handler
  // keeps using the orphaned local manager.
  let stateManager = getStateManager();
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
  // Gist checkpoint warnings from dashboard mutations (#1417). DELIBERATELY
  // separate from cachedPartialFailures: fetch failures clear on a successful
  // PULL, but a gist-sync warning means an un-pushed mutation, and a pull is
  // exactly the event that can destroy it (refreshFromGist wholesale-replaces
  // state). These clear only when a checkpoint PUSH succeeds.
  let pendingGistSyncWarnings: string[] = [];
  // Tracks the last background-refresh failure so /api/data can surface
  // staleness to the SPA via the X-Dashboard-Stale header (#1205). Cleared
  // when a refresh succeeds. Without this, token expiry / GitHub outage
  // produces silent stale data hours old with no client-visible signal.
  let lastBackgroundRefreshError: string | null = null;

  /** Record a mutation's checkpoint outcome. `null` means the push succeeded
   * (or local mode) — and a successful push carries the FULL current state,
   * so any previously pending warning is resolved with it. */
  function recordGistSyncOutcome(warning: string | null): void {
    if (warning === null) {
      pendingGistSyncWarnings = [];
      return;
    }
    if (!pendingGistSyncWarnings.includes(warning)) {
      pendingGistSyncWarnings.push(warning);
    }
  }

  /** Merge pending gist-sync warnings into a partialFailures payload for the
   * SPA banner without coupling their lifecycles. */
  function withPendingGistWarnings(failures: string[] | undefined): string[] | undefined {
    const extras = [...pendingGistSyncWarnings, ...recoveryLossNotices];
    if (gistConfiguredButLocal()) {
      extras.push(
        recoveryHaltedReason === null
          ? GIST_DEGRADED_WARNING
          : `Gist persistence is configured but recovery FAILED permanently: ${recoveryHaltedReason} — ` +
              'fix the Gist setup (check the token gist scope, or run state-show), then restart the dashboard.',
      );
    } else if (gistBootstrapDegraded()) {
      // Same halt surfacing as the local-only branch (#1443): a permanent
      // recovery failure must reach the banner here too, or the stale data
      // promise below would dangle forever with no visible reason.
      extras.push(
        recoveryHaltedReason === null
          ? GIST_STALE_BOOTSTRAP_WARNING
          : `Gist persistence is degraded and recovery FAILED permanently: ${recoveryHaltedReason} — ` +
              'fix the Gist setup (check the token gist scope, or run state-show), then restart the dashboard.',
      );
    }
    if (extras.length === 0) return failures;
    const base = failures ?? [];
    return [...base, ...extras.filter((w) => !base.includes(w))];
  }

  /** Push-before-pull (#1417): an un-pushed mutation would be silently
   * reverted by the next Gist pull. Retry the checkpoint first so a recovered
   * network turns the pending warning into a real push before any pull runs.
   * No-op when nothing is pending. */
  async function flushPendingGistSync(): Promise<void> {
    if (pendingGistSyncWarnings.length === 0) return;
    recordGistSyncOutcome(await maybeCheckpoint(stateManager, MODULE));
  }

  /** True while the config asks for gist but this process's manager is
   * local-only (#1433) — the degraded window in which every dashboard
   * mutation is acknowledged and then clobbered by the next pull. */
  function gistConfiguredButLocal(): boolean {
    // Defensive: this is an advisory check that runs on EVERY request path
    // (rebuilds, recovery probes). A getState failure has its own handling
    // wherever state is actually consumed — the degraded probe must not
    // become a new crash surface in front of it (#994's stale-serving path).
    try {
      return stateManager.getState().config.persistence === 'gist' && !stateManager.isGistMode();
    } catch (err) {
      warn(MODULE, `Degraded-gist probe failed (treating as not degraded): ${errorMessage(err)}`);
      return false;
    }
  }

  /** Gist-backed but the bootstrap itself fell back to the local cache —
   * reads may be stale even though isGistMode() is true (#1433 review). */
  function gistBootstrapDegraded(): boolean {
    try {
      return stateManager.isGistMode() && stateManager.isGistDegraded();
    } catch {
      return false;
    }
  }

  const GIST_DEGRADED_WARNING =
    'Gist persistence is configured but this dashboard process is running LOCAL-ONLY; ' +
    'changes made here will NOT sync and may be overwritten by the next successful Gist read. ' +
    'Recovery is retried automatically.';

  // #1443: a degraded bootstrap disarms the store, so "the next successful
  // Gist read" can never arrive on its own — maybeRecoverGist re-bootstraps
  // (the gate below treats this state as recoverable), which is the retry
  // this banner now promises.
  const GIST_STALE_BOOTSTRAP_WARNING =
    'Gist persistence is active but the last Gist read fell back to the local cache; ' +
    'data shown may be stale. Recovery is retried automatically.';

  // Recovery throttling + halt (#1433 review): a PERMANENT failure (token
  // lacks gist scope, corrupt Gist) must not turn every dashboard poll into
  // a doomed GitHub round trip for the life of the server, and its root
  // cause must reach the banner — the detached spawn discards stderr.
  const RECOVERY_RETRY_INTERVAL_MS = 30_000;
  let lastRecoveryAttemptAt = 0;
  let recoveryHaltedReason: string | null = null;

  // Mutations acknowledged while degraded (#1433 review): a successful
  // recovery bootstraps FROM the existing Gist, which reverts them — the
  // user must get a retrospective notice, not just the prospective banner
  // that clears at the exact moment of the loss. Cleared on a successful
  // full refresh (by then the user has seen the notice across the window).
  let degradedMutationCount = 0;
  let recoveryLossNotices: string[] = [];

  /** A successful PULL (refresh, or a recovery re-bootstrap) wholesale-
   * replaces in-memory state. If push warnings are still pending at that
   * moment, the mutations they describe are gone from the working state and
   * a LATER push can never carry them — so an unrelated future push must not
   * be allowed to "resolve" them (#1443). Convert the prospective warnings
   * into a retrospective loss notice. Lifecycle invariants from #1417/#1433
   * are unchanged: pending warnings still clear only via recordGistSyncOutcome
   * on a successful push, and loss notices still clear at the start of the
   * next refresh cycle. */
  function convertPendingWarningsToLossNotices(): void {
    if (pendingGistSyncWarnings.length === 0) return;
    recoveryLossNotices.push(
      `A Gist read replaced local state while ${pendingGistSyncWarnings.length} change(s) were still un-pushed — ` +
        'they were NOT synced to the Gist and may have been reverted in this view. Re-apply anything missing.',
    );
    pendingGistSyncWarnings = [];
  }

  /** Pull from the Gist, converting still-pending push warnings into a loss
   * notice when the pull actually replaced state (#1443). All dashboard pull
   * sites go through here; callers flush pending pushes first (#1417), so a
   * warning that is still pending at pull time means the flush failed. */
  async function pullFromGist(): Promise<boolean> {
    const refreshed = await stateManager.refreshFromGist();
    if (refreshed) convertPendingWarningsToLossNotices();
    return refreshed;
  }

  /** Re-attempt gist init while degraded (#1433). The serve process used to
   * bootstrap exactly once at CLI preAction — with its stderr discarded by
   * the detached spawn — and never retry, so one blip at startup meant
   * local-only writes for the server's lifetime. Never throws. Transient
   * failures retry no more often than RECOVERY_RETRY_INTERVAL_MS; permanent
   * (ConfigurationError-class) failures halt retries and surface the reason
   * in the banner.
   *
   * Covers BOTH degraded shapes (#1443): a local-only manager under a gist
   * config, and a gist-backed manager whose bootstrap fell back to the local
   * cache (disarmed store — refreshFromGist can never heal it on its own). */
  async function maybeRecoverGist(): Promise<void> {
    if (!gistConfiguredButLocal() && !gistBootstrapDegraded()) return;
    if (recoveryHaltedReason !== null) return;
    const now = Date.now();
    if (now - lastRecoveryAttemptAt < RECOVERY_RETRY_INTERVAL_MS) return;
    const currentToken = token || getGitHubToken();
    // A token-less probe is free (the auth cache answers instantly) and must
    // not burn the retry window — stamp only when a real attempt starts.
    if (!currentToken) return;
    lastRecoveryAttemptAt = now;
    try {
      await ensureGistPersistence(currentToken);
      // The upgrade replaced the core singleton — re-resolve our reference.
      stateManager = getStateManager();
      // Genuinely armed only: a retry can resolve via ANOTHER degraded
      // bootstrap (isGistMode() true, store disarmed) — that is not a
      // recovery and must not produce a recovery notice (#1443).
      const recovered = stateManager.isGistMode() && !stateManager.isGistDegraded();
      if (recovered) {
        // The re-bootstrap pulled the existing Gist: un-pushed mutations
        // from the degraded window are not in the replacement state.
        convertPendingWarningsToLossNotices();
      }
      if (recovered && degradedMutationCount > 0) {
        recoveryLossNotices.push(
          `Gist persistence recovered, but ${degradedMutationCount} change(s) made while degraded were ` +
            'saved locally only and were NOT merged into the Gist — they may have been reverted in this view. ' +
            'Re-apply anything missing.',
        );
        degradedMutationCount = 0;
      }
    } catch (err) {
      // ConfigurationError-class failures are permanent until the user acts
      // (#1202 semantics) — stop hammering GitHub and say WHY in the banner.
      if (err instanceof ConfigurationError) {
        recoveryHaltedReason = errorMessage(err);
      }
      warn(MODULE, `Gist recovery attempt failed: ${errorMessage(err)}`);
    }
  }

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
      withPendingGistWarnings(cachedPartialFailures),
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
        // Re-read state if modified externally (file mtime for local, Gist
        // API for Gist mode). Shared with the POST paths via reloadState()
        // so the recoveryHaltedReason un-halt lives in exactly one place —
        // this GET path used to hand-duplicate the sequence minus the
        // un-halt and had already drifted once (#1446 item 5). The #1443
        // degraded-bootstrap recovery (and its banner-clearing stateChanged
        // signal) lives inside reloadState too — do NOT add a second
        // maybeRecoverGist call here or recovery would double-run per poll.
        const stateChanged = await reloadState();
        // Gist-mode staleness (#1446 item 2): refreshFromGist() returns
        // false on BOTH "no change" and "fetch failed", so the boolean can't
        // signal failure. getStateStaleness() is the API built for exactly
        // this — StateManager sets the marker when in-memory state diverged
        // from the canonical Gist (refresh failure, invalid payload,
        // degraded bootstrap) and clears it on a successful pull.
        const staleness = stateManager.getStateStaleness();
        if (staleness !== null) {
          res.setHeader('X-Dashboard-Stale', '1');
          res.setHeader('X-Dashboard-Stale-Reason', sanitizeHeaderValue(`state-stale: ${staleness.reason}`));
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
              withPendingGistWarnings(cachedPartialFailures),
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
          res.setHeader(
            'X-Dashboard-Stale-Reason',
            sanitizeHeaderValue(`background-refresh-failed: ${lastBackgroundRefreshError}`),
          );
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

  /** A gist pull wholesale-replaces state, and the pulled state.lastDigest
   * may be NEWER than this server's long-lived cachedDigest (another machine
   * ran its daily check). Adopt it when its generatedAt is strictly newer so
   * cross-machine results appear without a manual full refresh (#1446
   * item 6). Unparsable timestamps compare as NaN and never adopt —
   * conservative: keep what we have. */
  function adoptNewerPulledDigest(): void {
    const pulled = stateManager.getState().lastDigest;
    if (!pulled) return;
    if (Date.parse(pulled.generatedAt) > Date.parse(cachedDigest.generatedAt)) {
      cachedDigest = pulled;
    }
  }

  /** Re-read state written by external processes (CLI) before mutating.
   * Returns true when the state source changed (gist pull refreshed, local
   * file reloaded, or a gist recovery completed) — GET /api/data uses this
   * to decide whether to rebuild the cached payload (#1446 item 5). */
  async function reloadState(): Promise<boolean> {
    if (stateManager.isGistMode()) {
      await flushPendingGistSync();
      // Both post-pull steps consume the same refreshFromGist outcome, in
      // this order: pullFromGist (#1443) settles the LOSS side first —
      // still-pending push warnings become a loss notice at the instant the
      // pull replaces state — then adoptNewerPulledDigest harvests the GAIN
      // side (#1446 item 6) by reading the freshly replaced state, so it
      // cannot run before the pull. Adoption stays out of pullFromGist
      // because the background-refresh path also pulls but replaces
      // cachedDigest unconditionally right after — adoption is a
      // reloadState-path concern only.
      const refreshed = await pullFromGist();
      if (refreshed) adoptNewerPulledDigest();
      if (gistBootstrapDegraded()) {
        // #1443: a degraded bootstrap keeps isGistMode() true while the
        // store is disarmed, so refreshFromGist() short-circuits forever
        // and the local-branch recovery below never sees it. Same
        // throttle/halt machinery applies inside maybeRecoverGist.
        await maybeRecoverGist();
        // A successful recovery replaced the singleton with state pulled
        // from the Gist — report a change so callers rebuild and the
        // stale-bootstrap banner clears now.
        if (!gistBootstrapDegraded()) return true;
      }
      return refreshed;
    }
    let changed = stateManager.reloadIfChanged();
    if (changed) {
      // An external config edit may BE the fix for a permanently-halted
      // recovery (new token scope, repaired gist id) — give it one fresh
      // attempt cycle (#1433 pass-2).
      recoveryHaltedReason = null;
    }
    // reloadIfChanged may have just pulled a persistence=gist flip made
    // from a terminal, and a degraded server heals here too (#1433).
    await maybeRecoverGist();
    // A successful recovery is a state-source change: rebuild so the
    // degraded banner clears without waiting for another edit.
    if (stateManager.isGistMode()) changed = true;
    return changed;
  }

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

    // Resolve the mutation up-front so target validation happens before the
    // state reload — keeps the reload-to-save freshness window minimal.
    // Each mutation records the Gist checkpoint outcome (#1417): in gist mode
    // `save()` only writes the local cache, and an un-pushed mutation can be
    // wholesale-reverted by the next successful refreshFromGist — so a failed
    // push must reach the SPA, not vanish into a discarded return value.
    let gistSyncWarning: string | null = null;
    let applyMutation: () => Promise<void> | void;
    if (body.action === 'move') {
      const { VALID_TARGETS, runMove } = await import('./move.js');
      if (!body.target || !VALID_TARGETS.includes(body.target as MoveTarget)) {
        sendError(res, 400, `move requires a valid "target" field (${VALID_TARGETS.join(', ')})`);
        return;
      }
      const target = body.target;
      applyMutation = async () => {
        const output = await runMove({ prUrl: body.url, target });
        gistSyncWarning = output.gistSyncWarning ?? null;
      };
    } else {
      // dismiss_issue_response
      applyMutation = async () => {
        stateManager.dismissIssue(body.url, new Date().toISOString());
        // Mirror runMove's contract: every mutating surface checkpoints to
        // Gist and surfaces the warning. Never throws — failures come back
        // as the warning string.
        gistSyncWarning = await maybeCheckpoint(stateManager, MODULE);
      };
    }

    // Reload state before mutating to avoid overwriting external CLI changes.
    // Runs AFTER body parsing/validation (which only inspects the request,
    // never the loaded state) so the read-modify-write window excludes the
    // body-streaming time (#1397).
    await reloadState();

    try {
      await applyMutation();
    } catch (error) {
      if (!isConcurrencyConflict(error)) {
        warn(MODULE, `Action failed: ${body.action} ${body.url} ${errorMessage(error)}`);
        sendError(res, 500, 'Action failed');
        return;
      }
      // Concurrency conflict: an external write landed between our reload and
      // save. Decision (#1397): retry ONCE server-side instead of bouncing the
      // first conflict to the client. Both mutations (move targets, dismiss)
      // are absolute set operations, so re-applying them on a freshly reloaded
      // baseline is safe — exactly the reload-reapply recovery contract pinned
      // in state-concurrency.test.ts. A second consecutive conflict means
      // sustained contention; surface it as a retryable 409 and let the SPA
      // re-prime and retry.
      try {
        await reloadState();
        await applyMutation();
      } catch (retryError) {
        if (isConcurrencyConflict(retryError)) {
          warn(MODULE, `Action conflicted twice: ${body.action} ${body.url} ${errorMessage(retryError)}`);
          sendConflict(res);
          return;
        }
        warn(MODULE, `Action failed on conflict retry: ${body.action} ${body.url} ${errorMessage(retryError)}`);
        sendError(res, 500, 'Action failed');
        return;
      }
    }

    // Surface the checkpoint outcome through the partialFailures banner the
    // SPA already renders (#1417). Tracked in pendingGistSyncWarnings — NOT
    // cachedPartialFailures — because gist warnings clear on a successful
    // PUSH, while fetch failures clear on a successful pull/refresh.
    recordGistSyncOutcome(gistSyncWarning);

    // Count mutations acknowledged while degraded (#1433): a later recovery
    // bootstraps from the existing Gist and reverts them, and the loss
    // notice needs to know whether there is anything to lose.
    if (gistConfiguredButLocal()) degradedMutationCount++;

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
      withPendingGistWarnings(cachedPartialFailures),
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
      // Clear PRE-EXISTING loss notices before the reload: by now they have
      // been visible across the degraded window. Order matters — this
      // refresh's own reloadState may RECOVER and produce a fresh notice,
      // which must survive into the rebuild below, not be wiped 10 lines
      // after its creation (#1433 pass-2).
      recoveryLossNotices = [];
      await reloadState();
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
        withPendingGistWarnings(cachedPartialFailures),
      );
      cachedIssueListMtimeMs = getIssueListMtimeMs();
      sendJson(res, 200, cachedJsonData);
    } catch (error) {
      // No server-side retry here (unlike handleAction): a refresh re-run is a
      // full GitHub fetch — expensive and rate-limited. The 409 is retryable
      // by the client, which re-POSTs /api/refresh on its own schedule (#1397).
      if (isConcurrencyConflict(error)) {
        warn(MODULE, `Dashboard refresh hit a concurrent state write: ${errorMessage(error)}`);
        sendConflict(res);
        return;
      }
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
        // Same clear-before-recover ordering as handleRefresh (#1433 pass-2).
        recoveryLossNotices = [];
        if (stateManager.isGistMode()) {
          await flushPendingGistSync();
          await pullFromGist();
          // Heal a degraded bootstrap from the background refresh too (#1443).
          if (gistBootstrapDegraded()) await maybeRecoverGist();
        } else {
          stateManager.reloadIfChanged();
          await maybeRecoverGist();
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
          withPendingGistWarnings(cachedPartialFailures),
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

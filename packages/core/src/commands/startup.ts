/**
 * Startup command
 * Combines all pre-flight checks into a single CLI invocation:
 * auth check, setup check, daily fetch, dashboard launch, version detection, issue list detection.
 *
 * Replaces the ~100-line inline bash script in commands/oss.md with a single
 * `node cli.bundle.cjs startup --json` call, reducing UI noise in Claude Code.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { getStateManager, getGitHubTokenAsync, getCLIVersion, detectGitHubUsername } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { type StartupOutput, type IssueListInfo } from '../formatters/json.js';
import { executeDailyCheck } from './daily.js';
import { launchDashboardServer, type LaunchResult } from './dashboard-lifecycle.js';
import { recordBrowserOpened } from './dashboard-process.js';
import { parseIssueList } from './parse-list.js';

/**
 * Parse issueListPath from a config file's YAML frontmatter.
 * @param configContent - Raw content of the config.md file
 * @returns The path string or undefined if not found
 */
export function parseIssueListPathFromConfig(configContent: string): string | undefined {
  const match = configContent.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return undefined;
  const frontmatter = match[1];
  const pathMatch = frontmatter.match(/issueListPath:\s*["']?([^"'\n]+)["']?/);
  return pathMatch ? pathMatch[1].trim() : undefined;
}

/**
 * Count available and completed items in an issue list file.
 * Available items exclude any vetting status that moves an item out of the
 * actionable pool — strikethrough, `**Done**`, and sub-bullet markers like
 * `**Skip**`, `**Merged**`, `**Dropped**`, `**Closed**`, `**In Progress**`,
 * `**Waiting**`. Matches the parse-issue-list command's classification (#907).
 */
export function countIssueListItems(content: string): { availableCount: number; completedCount: number } {
  const { availableCount, completedCount } = parseIssueList(content);
  return { availableCount, completedCount };
}

/**
 * Detect an issue list file from config or known paths.
 * @returns Issue list info with path and item counts, or undefined if not found
 */
export function detectIssueList(): IssueListInfo | undefined {
  let issueListPath = '';
  let source: IssueListInfo['source'] = 'auto-detected';

  // 1. Check state.json config (primary)
  try {
    const stateManager = getStateManager();
    const configuredPath = stateManager.getState().config.issueListPath;
    if (configuredPath && fs.existsSync(configuredPath)) {
      issueListPath = configuredPath;
      source = 'configured';
    }
  } catch (error) {
    // State manager may not be initialized yet — fall through to legacy config.md
    warn('startup', `Could not read issueListPath from state: ${errorMessage(error)}`);
  }

  // 2. Fallback: config.md (legacy — will be removed in future)
  if (!issueListPath) {
    const configPath = '.claude/oss-autopilot/config.md';
    if (fs.existsSync(configPath)) {
      try {
        const configContent = fs.readFileSync(configPath, 'utf8');
        const configuredPath = parseIssueListPathFromConfig(configContent);
        if (configuredPath && fs.existsSync(configuredPath)) {
          issueListPath = configuredPath;
          source = 'configured';
        }
      } catch (error) {
        console.error('[STARTUP] Failed to read config:', errorMessage(error));
      }
    }
  }

  // 3. Probe known paths
  if (!issueListPath) {
    const probes = ['open-source/potential-issue-list.md', 'oss/issue-list.md', 'issues.md'];
    for (const probe of probes) {
      if (fs.existsSync(probe)) {
        issueListPath = probe;
        source = 'auto-detected';
        break;
      }
    }
  }

  if (!issueListPath) return undefined;

  // 4. Count available/completed items
  let availableCount = 0;
  let completedCount = 0;
  try {
    const content = fs.readFileSync(issueListPath, 'utf8');
    ({ availableCount, completedCount } = countIssueListItems(content));
  } catch (error) {
    console.error(`[STARTUP] Failed to read issue list at ${issueListPath}:`, errorMessage(error));
  }

  // 5. Detect skipped issues file
  let skippedIssuesPath: string | undefined;

  // Check config first
  try {
    const stateManager = getStateManager();
    const configuredSkipPath = stateManager.getState().config.skippedIssuesPath;
    if (configuredSkipPath && fs.existsSync(configuredSkipPath)) {
      skippedIssuesPath = configuredSkipPath;
    }
  } catch (err) {
    // State access can fail on a degraded state file (corrupt JSON, EACCES).
    // Default-path probe below still runs; warn so the underlying cause is visible (#994).
    // Matches the sibling warn at line 64 for `issueListPath` read failures.
    warn('startup', `Could not read skippedIssuesPath from state: ${errorMessage(err)}`);
  }

  // Probe default path: same directory as issue list, named skipped-issues.md.
  // When found, also persist to state.config so downstream commands
  // (`skip-add`, `scout search`'s skip-list filter) read the same path
  // instead of silently no-opping with "No skipped-issues path configured"
  // (#1330). Without persistence, the auto-detect printed the path on
  // every startup but nothing else honored it — search would re-surface
  // already-skipped candidates round after round.
  if (!skippedIssuesPath && issueListPath) {
    const defaultSkipPath = path.join(path.dirname(issueListPath), 'skipped-issues.md');
    if (fs.existsSync(defaultSkipPath)) {
      skippedIssuesPath = defaultSkipPath;
      try {
        const stateManager = getStateManager();
        // Only write when config actually doesn't have one — re-running
        // startup shouldn't trigger an autoSave on every run if the
        // value is already there.
        const current = stateManager.getState().config.skippedIssuesPath;
        if (!current) {
          stateManager.updateConfig({ skippedIssuesPath: defaultSkipPath });
        }
      } catch (err) {
        // Persistence is best-effort — startup still surfaces the path
        // in its return value so the current run benefits, but the next
        // run won't. Log so the failure is debuggable.
        warn('startup', `Could not persist auto-detected skippedIssuesPath: ${errorMessage(err)}`);
      }
    }
  }

  return { path: issueListPath, source, availableCount, completedCount, skippedIssuesPath };
}

/**
 * Open a URL in the default system browser.
 * @param url - URL to open
 */
export function openInBrowser(url: string): void {
  let openCmd: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin': {
      openCmd = 'open';
      args = [url];
      break;
    }
    case 'win32': {
      openCmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    }
    default: {
      openCmd = 'xdg-open';
      args = [url];
      break;
    }
  }
  execFile(openCmd, args, (error) => {
    if (error) {
      console.error(`[STARTUP] Failed to open dashboard in browser: ${error.message}`);
    }
  });
}

/**
 * Trigger a data refresh on a running dashboard server.
 * Hits POST /api/refresh so the SPA picks up fresh data on its next poll.
 * Non-fatal: errors are logged but don't propagate (#830).
 */
const DEFAULT_REOPEN_THROTTLE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Resolve the browser-reopen throttle window from `OSS_DASHBOARD_REOPEN_THROTTLE_MS`,
 * falling back to {@link DEFAULT_REOPEN_THROTTLE_MS}. A value of `0` disables the
 * throttle entirely, restoring the pre-#1339 behavior of always re-opening.
 */
function getReopenThrottleMs(): number {
  const raw = process.env.OSS_DASHBOARD_REOPEN_THROTTLE_MS;
  if (!raw) return DEFAULT_REOPEN_THROTTLE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REOPEN_THROTTLE_MS;
}

/**
 * Decide whether `openInBrowser` should run. Throttles re-opens against an
 * already-running server's `lastBrowserOpenedAt` timestamp so back-to-back
 * `/oss` runs don't pile up duplicate tabs (#1339), while still re-surfacing
 * the dashboard for users who closed the tab and came back later (#1100).
 *
 * Fresh launches (`alreadyRunning === false`) always open; the new server has
 * no recorded open yet by definition.
 *
 * Set `OSS_NO_BROWSER=1` to skip opening unconditionally (e.g., headless / CI).
 */
function shouldOpenBrowser(spaResult: LaunchResult, throttleMs: number): boolean {
  if (process.env.OSS_NO_BROWSER === '1') return false;
  if (!spaResult.alreadyRunning) return true;
  if (throttleMs === 0) return true;
  const last = spaResult.lastBrowserOpenedAt;
  if (!last) return true;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return true;
  const elapsed = Date.now() - lastMs;
  if (elapsed < 0) return true; // clock skew or future timestamp; treat as stale
  return elapsed >= throttleMs;
}

async function triggerDashboardRefresh(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/refresh`, {
      method: 'POST',
      headers: { Origin: `http://oss.localhost:${port}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[STARTUP] Dashboard refresh returned ${res.status}: ${body}`);
      return false;
    }
    await res.text().catch(() => {});
    return true;
  } catch (error) {
    console.error(`[STARTUP] Could not trigger dashboard refresh: ${errorMessage(error)}`);
    return false;
  }
}

/**
 * Run startup checks and return structured output.
 * Returns StartupOutput with one of three shapes:
 * 1. Setup incomplete: `{ version, setupComplete: false }`
 * 2. Auth failure: `{ version, setupComplete: true, authError: "..." }`
 * 3. Success: `{ version, setupComplete: true, daily, dashboardUrl?, issueList? }`
 *
 * @returns Startup output with auth/setup status and daily digest
 * @throws {Error} If the daily check fails (auth or network errors propagate)
 */
export async function runStartup(): Promise<StartupOutput> {
  const version = getCLIVersion();
  const stateManager = getStateManager();

  // 1. Check setup — auto-detect if incomplete
  let autoDetected = false;
  if (!stateManager.isSetupComplete()) {
    const detectedUsername = await detectGitHubUsername();
    if (detectedUsername) {
      try {
        stateManager.initializeWithDefaults(detectedUsername);
        autoDetected = true;
      } catch (err) {
        console.error(
          `[STARTUP] Auto-detected username "${detectedUsername}" but failed to save config:`,
          errorMessage(err),
        );
        return { version, setupComplete: false };
      }
    } else {
      return { version, setupComplete: false };
    }
  }

  // 2. Check auth — use the async variant so the `gh auth token` CLI fallback
  // fires for users who ran `gh auth login` but never exported $GITHUB_TOKEN.
  // The sync `getGitHubToken()` reads only the env var, matching the `preAction`
  // token check that the CLI's `localOnly: true` flag on `startup` deliberately
  // skips — the mismatch produced a spurious `authError` for valid users.
  const token = await getGitHubTokenAsync();
  if (!token) {
    return {
      version,
      setupComplete: true,
      authError:
        'GitHub authentication required. Install GitHub CLI (https://cli.github.com/) and run "gh auth login", or set GITHUB_TOKEN.',
    };
  }

  // 3. Run daily check
  const daily = await executeDailyCheck(token);

  // 4. Launch interactive SPA dashboard.
  //
  // Launched unconditionally once setup and auth pass. A prior heuristic skipped
  // launch whenever `totalActivePRs === 0`, assuming that meant a genuine first
  // run and deferring to the CLI's welcome flow. That gate also swallowed the
  // dashboard in three legitimate cases: a misconfigured/stale `githubUsername`
  // (Search API returns zero), transient GitHub API flakes (state still holds
  // merged PRs but the live count is zero), and users genuinely between PRs.
  // The dashboard's own empty-state UI renders "no PRs" cleanly, so always
  // surfacing it is the right default.
  let dashboardUrl: string | undefined;
  let dashboardStatus: 'opened' | 'refreshed' | 'running' | undefined;
  let dashboardError: string | undefined;

  try {
    const spaResult = await launchDashboardServer();
    if (spaResult) {
      dashboardUrl = spaResult.url;
      if (spaResult.alreadyRunning) {
        const refreshed = await triggerDashboardRefresh(spaResult.port);
        dashboardStatus = refreshed ? 'refreshed' : 'running';
      } else {
        dashboardStatus = 'opened';
      }
      // Throttle re-opens against the running server's last-opened timestamp
      // so back-to-back /oss runs don't pile up duplicate tabs (#1339), while
      // still re-surfacing the dashboard for users who closed the tab and
      // came back later (#1100). `OSS_NO_BROWSER=1` skips entirely;
      // `OSS_DASHBOARD_REOPEN_THROTTLE_MS=0` restores always-open behavior.
      if (shouldOpenBrowser(spaResult, getReopenThrottleMs())) {
        openInBrowser(spaResult.url);
        recordBrowserOpened(spaResult.port);
      }
    } else {
      dashboardError = 'Dashboard SPA assets not found. Build with: cd packages/dashboard && pnpm run build';
      console.error(`[STARTUP] ${dashboardError}`);
    }
  } catch (error) {
    dashboardError = `SPA dashboard launch failed: ${errorMessage(error)}`;
    console.error(`[STARTUP] ${dashboardError}`);
  }

  // Append dashboard status to brief summary
  if (dashboardStatus === 'opened') {
    daily.briefSummary += ' | Dashboard opened in browser';
  } else if (dashboardStatus === 'refreshed') {
    daily.briefSummary += ' | Dashboard refreshed';
  } else if (dashboardStatus === 'running') {
    daily.briefSummary += ' | Dashboard running';
  }

  // 5. Detect issue list
  const issueList = detectIssueList();

  // 6. Pass through dashboard-build status set by the workflow shell (#1293).
  // The workflow runs the SPA build BEFORE invoking startup, so the status
  // arrives here via env vars rather than being something runStartup itself
  // computes. Validate the env value so a malformed export can't sneak an
  // arbitrary string into a typed enum.
  const rawBuildStatus = process.env.OSS_DASHBOARD_BUILD_STATUS;
  const dashboardBuildStatus: StartupOutput['dashboardBuildStatus'] =
    rawBuildStatus === 'fresh' ||
    rawBuildStatus === 'rebuilt' ||
    rawBuildStatus === 'failed' ||
    rawBuildStatus === 'missing-pnpm'
      ? rawBuildStatus
      : undefined;
  const rawBuildErrorTail = process.env.OSS_DASHBOARD_BUILD_ERROR_TAIL;
  const dashboardBuildErrorTail =
    (dashboardBuildStatus === 'failed' || dashboardBuildStatus === 'missing-pnpm') && rawBuildErrorTail
      ? rawBuildErrorTail
      : undefined;

  return {
    version,
    setupComplete: true,
    autoDetected,
    daily,
    dashboardUrl,
    dashboardError,
    dashboardBuildStatus,
    dashboardBuildErrorTail,
    issueList,
  };
}

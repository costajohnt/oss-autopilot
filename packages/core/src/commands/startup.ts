/**
 * Startup command
 * Combines all pre-flight checks into a single CLI invocation:
 * auth check, setup check, daily fetch, dashboard launch, version detection, issue list detection.
 *
 * Replaces the ~100-line inline bash script in commands/oss.md with a single
 * `node cli.bundle.cjs startup --json` call, reducing UI noise in Claude Code.
 */

import * as fs from 'fs';
import { execFile } from 'child_process';
import { getStateManager, getGitHubToken, getCLIVersion, detectGitHubUsername } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { warn } from '../core/logger.js';
import { type StartupOutput, type IssueListInfo } from '../formatters/json.js';
import { executeDailyCheck } from './daily.js';
import { launchDashboardServer } from './dashboard-lifecycle.js';

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
 * Available: list items (`- [`) NOT struck through or marked Done.
 * Completed: list items that ARE struck through or marked Done.
 *
 * @param content - Raw markdown content of the issue list
 * @returns Counts of available and completed items
 */
export function countIssueListItems(content: string): { availableCount: number; completedCount: number } {
  let availableCount = 0;
  let completedCount = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    // Match list items: "- [" or "- ~~[" (strikethrough completed items)
    if (/^\s*- (?:~~)?\[/.test(line)) {
      if (/~~|\*\*Done\*\*/.test(line)) {
        completedCount++;
      } else {
        availableCount++;
      }
    }
  }
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
        const configContent = fs.readFileSync(configPath, 'utf-8');
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
  try {
    const content = fs.readFileSync(issueListPath, 'utf-8');
    const { availableCount, completedCount } = countIssueListItems(content);
    return { path: issueListPath, source, availableCount, completedCount };
  } catch (error) {
    console.error(`[STARTUP] Failed to read issue list at ${issueListPath}:`, errorMessage(error));
    return { path: issueListPath, source, availableCount: 0, completedCount: 0 };
  }
}

/**
 * Open a URL in the default system browser.
 * @param url - URL to open
 */
export function openInBrowser(url: string): void {
  let openCmd: string;
  let args: string[];
  switch (process.platform) {
    case 'darwin':
      openCmd = 'open';
      args = [url];
      break;
    case 'win32':
      openCmd = 'cmd';
      args = ['/c', 'start', '', url];
      break;
    default:
      openCmd = 'xdg-open';
      args = [url];
      break;
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

  // 2. Check auth
  const token = getGitHubToken();
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

  // 4. Launch interactive SPA dashboard
  // Skip opening on first run (0 PRs) — the welcome flow handles onboarding
  let dashboardUrl: string | undefined;
  let dashboardStatus: 'opened' | 'refreshed' | 'running' | undefined;

  if (daily.digest.summary.totalActivePRs > 0) {
    try {
      const spaResult = await launchDashboardServer();
      if (spaResult) {
        dashboardUrl = spaResult.url;
        if (spaResult.alreadyRunning) {
          const refreshed = await triggerDashboardRefresh(spaResult.port);
          dashboardStatus = refreshed ? 'refreshed' : 'running';
        } else {
          openInBrowser(spaResult.url);
          dashboardStatus = 'opened';
        }
      } else {
        console.error('[STARTUP] Dashboard SPA assets not found. Build with: cd packages/dashboard && pnpm run build');
      }
    } catch (error) {
      console.error('[STARTUP] SPA dashboard launch failed:', errorMessage(error));
    }
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

  return {
    version,
    setupComplete: true,
    autoDetected,
    daily,
    dashboardUrl,
    issueList,
  };
}

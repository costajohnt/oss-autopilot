/**
 * Startup command
 * Combines all pre-flight checks into a single CLI invocation:
 * auth check, setup check, daily fetch, dashboard generation, version detection, issue list detection.
 *
 * Replaces the ~100-line inline bash script in commands/oss.md with a single
 * `node cli.bundle.cjs startup --json` call, reducing UI noise in Claude Code.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { getStateManager, getGitHubToken } from '../core/index.js';
import { errorMessage } from '../core/errors.js';
import { type StartupOutput, type IssueListInfo } from '../formatters/json.js';
import { executeDailyCheck } from './daily.js';
import { writeDashboardFromState } from './dashboard.js';

function getVersion(): string {
  try {
    const pkgPath = path.join(path.dirname(process.argv[1]), '..', 'package.json');
    return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version;
  } catch (error) {
    console.error('[STARTUP] Failed to detect CLI version:', errorMessage(error));
    return '0.0.0';
  }
}

/**
 * Parse issueListPath from a config file's YAML frontmatter.
 * Returns the path string or undefined if not found.
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
 * Available: list items (- [) NOT struck through or marked Done.
 * Completed: list items that ARE struck through or marked Done.
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
 * Returns IssueListInfo or undefined if no list found.
 */
export function detectIssueList(): IssueListInfo | undefined {
  let issueListPath = '';
  let source: IssueListInfo['source'] = 'auto-detected';

  // 1. Check config file for configured path
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

  // 2. Probe known paths
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

  // 3. Count available/completed items
  try {
    const content = fs.readFileSync(issueListPath, 'utf-8');
    const { availableCount, completedCount } = countIssueListItems(content);
    return { path: issueListPath, source, availableCount, completedCount };
  } catch (error) {
    console.error(`[STARTUP] Failed to read issue list at ${issueListPath}:`, errorMessage(error));
    return { path: issueListPath, source, availableCount: 0, completedCount: 0 };
  }
}

function openInBrowser(filePath: string): void {
  const isWindows = process.platform === 'win32';
  const openCmd = process.platform === 'darwin' ? 'open' : isWindows ? 'cmd' : 'xdg-open';
  const args = isWindows ? ['/c', 'start', '', filePath] : [filePath];
  execFile(openCmd, args, (error) => {
    if (error) {
      console.error(`[STARTUP] Failed to open dashboard in browser: ${error.message}`);
    }
  });
}

/**
 * Run startup checks and return structured output.
 * Returns StartupOutput with one of three shapes:
 * 1. Setup incomplete: { version, setupComplete: false }
 * 2. Auth failure: { version, setupComplete: true, authError: "..." }
 * 3. Success: { version, setupComplete: true, daily, dashboardPath?, issueList? }
 *
 * Errors from the daily check propagate to the caller.
 */
export async function runStartup(): Promise<StartupOutput> {
  const version = getVersion();
  const stateManager = getStateManager();

  // 1. Check setup
  if (!stateManager.isSetupComplete()) {
    return { version, setupComplete: false };
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

  // 4. Generate dashboard from state (just saved by daily)
  // Skip opening on first run (0 PRs) — the welcome flow handles onboarding
  let dashboardPath: string | undefined;
  let dashboardOpened = false;
  try {
    dashboardPath = writeDashboardFromState();
    if (daily.digest.summary.totalActivePRs > 0) {
      openInBrowser(dashboardPath);
      dashboardOpened = true;
    }
  } catch (error) {
    console.error('[STARTUP] Dashboard generation failed:', errorMessage(error));
  }

  // Append dashboard status to brief summary (only startup opens the browser, not daily)
  if (dashboardOpened) {
    daily.briefSummary += ' | Dashboard opened in browser';
  }

  // 5. Detect issue list
  const issueList = detectIssueList();

  return {
    version,
    setupComplete: true,
    daily,
    dashboardPath,
    issueList,
  };
}

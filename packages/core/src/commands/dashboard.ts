/**
 * Dashboard command — thin orchestrator.
 * Coordinates data fetching, template generation, and file output.
 * v2: Fetches fresh data from GitHub if token available, otherwise uses cached lastDigest.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { getStateManager, getDashboardPath, getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import type { CommentedIssue, CommentedIssueWithResponse, DailyDigest } from '../core/types.js';
import { fetchDashboardData, computePRsByRepo, computeTopRepos, getMonthlyData } from './dashboard-data.js';
import { buildDashboardStats, generateDashboardHtml } from './dashboard-templates.js';

interface DashboardOptions {
  open?: boolean;
  json?: boolean;
  offline?: boolean;
}

export async function runDashboard(options: DashboardOptions): Promise<void> {
  const stateManager = getStateManager();
  const token = options.offline ? null : getGitHubToken();
  let digest: DailyDigest | undefined;
  let commentedIssues: CommentedIssue[] = [];

  // In offline mode, skip all GitHub API calls
  if (options.offline) {
    const state = stateManager.getState();
    digest = state.lastDigest;
    if (!digest) {
      if (options.json) {
        outputJson({ error: 'No cached data found. Run without --offline first.', offline: true });
      } else {
        console.error('No cached data found. Run without --offline first.');
      }
      return;
    }
    const lastUpdated = digest.generatedAt || state.lastDigestAt || state.lastRunAt;
    console.error(`Offline mode: using cached data from ${lastUpdated}`);
  } else if (token) {
    console.error('Fetching fresh data from GitHub...');
    try {
      const result = await fetchDashboardData(token);
      digest = result.digest;
      commentedIssues = result.commentedIssues;
    } catch (error) {
      console.error('Failed to fetch fresh data:', error instanceof Error ? error.message : error);
      console.error('Falling back to cached data (issue conversations unavailable)...');
      digest = stateManager.getState().lastDigest;
    }
  } else {
    // No token and not offline — fall back to cached digest
    digest = stateManager.getState().lastDigest;
  }

  // Check if we have a digest to display
  if (!digest) {
    if (options.json) {
      outputJson({ error: 'No data available. Run daily check first with GITHUB_TOKEN.' });
    } else {
      console.error('No dashboard data available. Run the daily check first:');
      console.error('  GITHUB_TOKEN=$(gh auth token) npm start -- daily');
    }
    return;
  }

  const state = stateManager.getState();

  // Gather data for charts from digest
  const prsByRepo = computePRsByRepo(digest, state);
  const topRepos = computeTopRepos(prsByRepo);
  const { monthlyMerged, monthlyClosed, monthlyOpened } = getMonthlyData(state);

  const stats = buildDashboardStats(digest, state);

  if (options.json) {
    const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');
    const jsonData: Record<string, unknown> = {
      stats,
      prsByRepo,
      topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
      monthlyMerged,
      activePRs: digest.openPRs || [],
      commentedIssues,
      issueResponses,
    };
    if (options.offline) {
      jsonData.offline = true;
      jsonData.lastUpdated = digest.generatedAt || state.lastDigestAt || state.lastRunAt;
    }
    outputJson(jsonData);
    return;
  }

  const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');
  const html = generateDashboardHtml(stats, monthlyMerged, monthlyClosed, monthlyOpened, digest, state, issueResponses);

  // Write to file in ~/.oss-autopilot/
  const dashboardPath = getDashboardPath();
  fs.writeFileSync(dashboardPath, html, { mode: 0o644 });
  fs.chmodSync(dashboardPath, 0o644);

  if (options.offline) {
    const lastUpdated = digest.generatedAt || state.lastDigestAt || state.lastRunAt;
    console.log(`\n📊 Dashboard generated (offline, cached data from ${lastUpdated}): ${dashboardPath}`);
  } else {
    console.log(`\n📊 Dashboard generated: ${dashboardPath}`);
  }

  if (options.open) {
    // Use platform-specific open command - path is hardcoded, not user input
    const isWindows = process.platform === 'win32';
    const openCmd = process.platform === 'darwin' ? 'open' : isWindows ? 'cmd' : 'xdg-open';
    const args = isWindows ? ['/c', 'start', '', dashboardPath] : [dashboardPath];

    console.log(`Dashboard: ${dashboardPath}`);
    execFile(openCmd, args, (error) => {
      if (error) {
        console.error('Failed to open browser:', error.message);
        console.error(`Open manually: ${dashboardPath}`);
      }
    });
  } else {
    console.log('Run with --open to open in browser');
  }
}

/**
 * Generate dashboard HTML from state (no GitHub fetch).
 * Call after executeDailyCheck() which saves fresh data to state.
 * Returns the path to the generated dashboard HTML file.
 */
export function writeDashboardFromState(): string {
  const stateManager = getStateManager();
  const state = stateManager.getState();
  const digest = state.lastDigest;

  if (!digest) {
    throw new Error('No digest data available. Run daily check first.');
  }

  const { monthlyMerged, monthlyClosed, monthlyOpened } = getMonthlyData(state);

  const stats = buildDashboardStats(digest, state);

  const html = generateDashboardHtml(stats, monthlyMerged, monthlyClosed, monthlyOpened, digest, state);

  const dashboardPath = getDashboardPath();
  fs.writeFileSync(dashboardPath, html, { mode: 0o644 });
  fs.chmodSync(dashboardPath, 0o644);

  return dashboardPath;
}

// ── Serve (interactive dashboard) ──────────────────────────────────────────

interface ServeOptions {
  port: number;
  open: boolean;
}

/**
 * Resolve the SPA assets directory from packages/dashboard/dist/.
 * Tries multiple strategies to locate it across dev (tsx) and bundled (cjs) modes.
 */
function resolveAssetsDir(): string | null {
  // Strategy 1: relative to this source file (works in dev with tsx)
  const devPath = path.resolve(__dirname, '../../dashboard/dist');
  if (fs.existsSync(path.join(devPath, 'index.html'))) {
    return devPath;
  }

  // Strategy 2: relative to the CLI bundle location (packages/core/dist/cli.bundle.cjs)
  const bundlePath = path.resolve(path.dirname(process.argv[1]), '../../dashboard/dist');
  if (fs.existsSync(path.join(bundlePath, 'index.html'))) {
    return bundlePath;
  }

  // Strategy 3: resolve the dashboard package via require.resolve
  try {
    const dashboardPkgPath = require.resolve('@oss-autopilot/dashboard/package.json');
    const dashboardDist = path.join(path.dirname(dashboardPkgPath), 'dist');
    if (fs.existsSync(path.join(dashboardDist, 'index.html'))) {
      return dashboardDist;
    }
  } catch {
    // Package not installed — fall through
  }

  return null;
}

export async function serveDashboard(options: ServeOptions): Promise<void> {
  const assetsDir = resolveAssetsDir();
  if (!assetsDir) {
    console.error('Could not find dashboard SPA assets.');
    console.error('Make sure packages/dashboard has been built:');
    console.error('  cd packages/dashboard && pnpm run build');
    process.exit(1);
  }

  const token = getGitHubToken();

  const { startDashboardServer } = await import('./dashboard-server.js');
  await startDashboardServer({
    port: options.port,
    assetsDir,
    token,
    open: options.open,
  });
}

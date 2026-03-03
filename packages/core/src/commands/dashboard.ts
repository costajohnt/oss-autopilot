/**
 * Dashboard command — serves the interactive Preact SPA dashboard.
 * Also provides writeDashboardFromState() for generating a static HTML fallback
 * when the SPA cannot be launched (e.g., assets not built).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getStateManager, getDashboardPath, getGitHubToken } from '../core/index.js';
import { getMonthlyData } from './dashboard-data.js';
import { buildDashboardStats, generateDashboardHtml } from './dashboard-templates.js';

// ── Static HTML fallback ────────────────────────────────────────────────────

/**
 * Generate dashboard HTML from state (no GitHub fetch).
 * Call after executeDailyCheck() which saves fresh data to state.
 * Returns the path to the generated dashboard HTML file.
 *
 * Used as a safety net when the interactive SPA dashboard cannot be launched.
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
export function resolveAssetsDir(): string | null {
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code !== 'MODULE_NOT_FOUND') {
      console.error('Error resolving dashboard package:', error);
    }
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

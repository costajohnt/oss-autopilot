/**
 * Dashboard command — serves the interactive Preact SPA dashboard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { getGitHubToken } from '../core/index.js';

// ── Serve (interactive dashboard) ──────────────────────────────────────────

interface ServeOptions {
  port: number;
  open: boolean;
}

/**
 * Resolve the SPA assets directory. Tries packages/dashboard/dist/ in a
 * checkout (dev via tsx, or the bundle), then the copy shipped in the npm package.
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

  // Strategy 3: assets shipped inside the published package. `prepublishOnly`
  // copies packages/dashboard/dist to dist/dashboard, next to the CLI bundle,
  // because @oss-autopilot/dashboard itself is private and never on npm. Kept
  // after the checkout paths so a working tree serves its own fresh build.
  const packagedPath = path.resolve(__dirname, 'dashboard');
  if (fs.existsSync(path.join(packagedPath, 'index.html'))) {
    return packagedPath;
  }

  // Strategy 4: resolve the dashboard package via require.resolve
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
    console.error('From a git checkout, build them: cd packages/dashboard && pnpm run build');
    console.error('From npm, update to the latest @oss-autopilot/core; older releases did not include them.');
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

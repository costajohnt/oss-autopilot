/**
 * Dashboard server lifecycle management.
 * Handles launching the interactive SPA dashboard as a background process
 * and detecting whether a server is already running.
 */

import { spawn } from 'child_process';
import { findRunningDashboardServer, isDashboardServerRunning, readDashboardServerInfo } from './dashboard-server.js';
import { resolveAssetsDir } from './dashboard.js';

const DEFAULT_PORT = 3000;
const POLL_INTERVAL_MS = 200;
const MAX_POLL_ATTEMPTS = 25; // 5 seconds total

export interface LaunchResult {
  url: string;
  port: number;
  alreadyRunning: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch the interactive dashboard SPA server as a detached background process.
 *
 * Returns the server URL if launched successfully, or null if the SPA assets
 * are not available (caller should fall back to static HTML).
 *
 * If a server is already running (detected via PID file + health probe),
 * returns its URL without launching a new one.
 */
export async function launchDashboardServer(options?: { port?: number }): Promise<LaunchResult | null> {
  // 1. Check if SPA assets exist
  const assetsDir = resolveAssetsDir();
  if (!assetsDir) {
    return null;
  }

  // 2. Check if a server is already running
  const existing = await findRunningDashboardServer();
  if (existing) {
    return { url: existing.url, port: existing.port, alreadyRunning: true };
  }

  // 3. Launch as detached child process
  const port = options?.port ?? DEFAULT_PORT;
  // process.argv[1] is the CLI entry point (cli.bundle.cjs in production, cli.ts in dev)
  const cliPath = process.argv[1];

  const child = spawn('node', [cliPath, 'dashboard', 'serve', '--port', String(port), '--no-open'], {
    detached: true,
    stdio: 'ignore',
  });

  // Track spawn failures and early exits so the polling loop can bail early
  let spawnFailed = false;
  let childExited = false;
  child.on('error', (err) => {
    spawnFailed = true;
    console.error(`[STARTUP] Failed to spawn dashboard server: ${err.message}`);
  });
  child.on('exit', (code) => {
    childExited = true;
    if (code !== 0 && code !== null) {
      console.error(`[STARTUP] Dashboard server exited prematurely (code ${code})`);
    }
  });
  child.unref();

  // 4. Poll for PID file to appear (server writes it after binding)
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL_MS);

    // Bail early if spawn failed or child crashed before writing PID file
    if (spawnFailed || childExited) {
      return null;
    }

    const info = readDashboardServerInfo();
    if (info) {
      // PID file appeared — verify the server is responding
      if (await isDashboardServerRunning(info.port)) {
        return { url: `http://localhost:${info.port}`, port: info.port, alreadyRunning: false };
      }
    }
  }

  // 5. Timeout — server didn't start in time; kill orphan process
  console.error('[STARTUP] Dashboard server failed to start within 5 seconds');
  if (child.pid) {
    try {
      process.kill(child.pid, 'SIGTERM');
    } catch (err) {
      // ESRCH = process already exited, which is fine
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        console.error(
          `[STARTUP] Failed to kill orphan dashboard process (PID ${child.pid}): ${(err as Error).message}`,
        );
      }
    }
  }
  return null;
}

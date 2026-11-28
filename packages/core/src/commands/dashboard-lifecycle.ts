/**
 * Dashboard server lifecycle management.
 * Handles launching the interactive SPA dashboard as a background process
 * and detecting whether a server is already running.
 */

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  isDashboardServeProcess,
  isDashboardServerRunning,
  probeDashboardServer,
  readDashboardServerInfo,
  removeDashboardServerInfo,
  type DashboardServerInfo,
} from './dashboard-process.js';
import { resolveAssetsDir } from './dashboard.js';
import { getCLIVersion, getDataDir } from '../core/index.js';

const DEFAULT_PORT = 3000;
const POLL_INTERVAL_MS = 200;
const MAX_POLL_ATTEMPTS = 25; // 5 seconds total

export interface LaunchResult {
  url: string;
  port: number;
  alreadyRunning: boolean;
  /**
   * When `alreadyRunning` is true, the timestamp the running server most
   * recently recorded a browser-open at (or undefined if never recorded).
   * Used by startup to throttle duplicate browser tabs across `/oss` runs.
   * Always undefined for fresh launches.
   */
  lastBrowserOpenedAt?: string;
}

/**
 * The script to spawn `dashboard serve` with. From the CLI that is argv[1]
 * (cli.bundle.cjs in production, cli.ts in dev). From another host process
 * such as the MCP server, argv[1] is that host's own entry, so use the core
 * CLI bundle that ships beside the dashboard assets instead (#1735).
 */
export function resolveCliEntry(argv1: string, assetsDir: string): string {
  if (/^cli\.(?:bundle\.cjs|ts|js)$/.test(path.basename(argv1))) return argv1;
  const coreBundle = path.resolve(assetsDir, '../../core/dist/cli.bundle.cjs');
  return fs.existsSync(coreBundle) ? coreBundle : argv1;
}

/** Open `logFile` for appending and mark where this server's output starts. */
function openLogFile(logFile: string): number {
  const fd = fs.openSync(logFile, 'a', 0o600);
  fs.writeSync(fd, `--- dashboard server started ${new Date().toISOString()} ---\n`);
  return fd;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `x.y.z` of a version string, or null when it does not start with one. */
function parseVersion(version: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * How the version a server recorded compares with the current CLI's. A PID
 * file with no version predates the stamp (#548), so it is older. `unknown`
 * when either side cannot be read (`getCLIVersion` falls back to 0.0.0).
 */
function compareServerVersion(
  serverVersion: string | undefined,
  currentVersion: string,
): 'older' | 'same' | 'newer' | 'unknown' {
  const current = currentVersion === '0.0.0' ? null : parseVersion(currentVersion);
  if (!current) return 'unknown';
  if (serverVersion === undefined) return 'older';
  const server = parseVersion(serverVersion);
  if (!server) return 'unknown';
  for (let i = 0; i < 3; i++) {
    if (server[i] < current[i]) return 'older';
    if (server[i] > current[i]) return 'newer';
  }
  return 'same';
}

/**
 * SIGTERM the server the PID file records and remove the file. False when the
 * signal could not be delivered (e.g. EPERM): the server is still up.
 */
function stopDashboardServer(info: DashboardServerInfo): boolean {
  try {
    process.kill(info.pid, 'SIGTERM');
  } catch (err) {
    // ESRCH = already exited
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') {
      console.error(`[DASHBOARD] Could not kill outdated dashboard (PID ${info.pid}): ${(err as Error).message}`);
      return false;
    }
  }
  removeDashboardServerInfo();
  return true;
}

/**
 * Stop the running dashboard server if an older CLI version launched it (#548).
 *
 * The server's refresh path re-classifies PRs with its own bundled code and
 * writes the result to state, so an old-version server overwrites whatever a
 * newer `daily` just wrote (#1709). The server cannot detect this itself:
 * plugin updates install into a new versioned directory, so the old server's
 * own package.json never changes. Callers running the current CLI (startup,
 * `daily`, `dashboard launch`) therefore make the check.
 *
 * A newer server is left running: a long-lived session on an old plugin root
 * must not replace it with its own older code (#1882).
 *
 * A server that does not answer `/api/health` as ours (one from before 3.43.0
 * has no such route, and a busy one can miss the timeout) is stopped too
 * unless it is newer, but only after its command line identifies it as
 * `dashboard serve`. Otherwise the PID may have been recycled to an unrelated
 * process and is never signalled (#1927).
 *
 * Returns the running server when it is left up (same, newer or unknown
 * version, or the kill failed), or null when none is running or it was stopped.
 */
export async function stopStaleDashboardServer(): Promise<LaunchResult | null> {
  const probe = await probeDashboardServer();
  if (probe.status === 'none') return null;

  const { info } = probe;
  const running: LaunchResult = {
    url: `http://oss.localhost:${info.port}`,
    port: info.port,
    alreadyRunning: true,
    lastBrowserOpenedAt: info.lastBrowserOpenedAt,
  };
  const currentVersion = getCLIVersion();
  const age = compareServerVersion(info.version, currentVersion);

  if (probe.status === 'running') {
    // A server that answers /api/health is 3.43.0 or later and always records
    // its version; keep the old reading of a missing one as "leave it".
    if (!info.version || age !== 'older') return running;
    console.error(
      `[DASHBOARD] Dashboard server version mismatch (running: ${info.version}, current: ${currentVersion}). Stopping it...`,
    );
    return stopDashboardServer(info) ? null : running;
  }

  if (age === 'unknown' || !isDashboardServeProcess(info.pid)) {
    // Not identified as our server, or no version to compare: the stale-PID-file
    // case. Never signal it (#1927).
    removeDashboardServerInfo();
    return null;
  }
  if (age === 'newer') return running;

  console.error(
    `[DASHBOARD] Dashboard server (PID ${info.pid}, version ${info.version ?? 'unknown'}) did not answer the health check. Stopping it...`,
  );
  return stopDashboardServer(info) ? null : running;
}

/**
 * Launch the interactive dashboard SPA server as a detached background process.
 *
 * Returns the server URL if launched successfully, or null if the SPA assets
 * are not available (dashboard is skipped).
 *
 * If a server from the current version is already running (detected via PID
 * file + health probe), returns its URL without launching a new one. A server
 * from another version is stopped first, even when the assets are missing and
 * no replacement can be launched (#1709).
 */
export async function launchDashboardServer(options?: {
  port?: number;
  /** Append the server's stdout and stderr here instead of discarding them. */
  logFile?: string;
}): Promise<LaunchResult | null> {
  // 1. Check if SPA assets exist
  const assetsDir = resolveAssetsDir();
  if (!assetsDir) {
    await stopStaleDashboardServer();
    return null;
  }

  // 2. Reuse a running server unless it is from a different CLI version
  const running = await stopStaleDashboardServer();
  if (running) return running;

  // 3. Launch as detached child process
  const port = options?.port ?? DEFAULT_PORT;
  const cliPath = resolveCliEntry(process.argv[1], assetsDir);

  const logFd = options?.logFile ? openLogFile(options.logFile) : undefined;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('node', [cliPath, 'dashboard', 'serve', '--port', String(port), '--no-open'], {
      detached: true,
      stdio: logFd === undefined ? 'ignore' : ['ignore', logFd, logFd],
    });
  } finally {
    // The child holds its own copy of the descriptor.
    if (logFd !== undefined) fs.closeSync(logFd);
  }

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
    // PID file appeared — verify the server is responding
    if (info && (await isDashboardServerRunning(info.port, info.pid))) {
      return { url: `http://oss.localhost:${info.port}`, port: info.port, alreadyRunning: false };
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

export interface DashboardLaunchOutput {
  status: 'launched' | 'already_running';
  url: string;
  port: number;
  /** Where the server's output goes when this command started it. */
  logFile: string;
}

/**
 * `dashboard launch`: reuse the running server or start one in the
 * background, through the same version check and health probe as startup.
 * The `/oss-dashboard` command calls this instead of probing the server
 * itself (#2039).
 */
export async function runDashboardLaunch(options: { port: number }): Promise<DashboardLaunchOutput> {
  const logFile = path.join(getDataDir(), 'dashboard.log');
  const result = await launchDashboardServer({ port: options.port, logFile });
  if (!result) {
    if (!resolveAssetsDir()) {
      throw new Error('Dashboard SPA assets not found. Build with: cd packages/dashboard && pnpm run build');
    }
    throw new Error(`Dashboard server did not start. Logs: ${logFile}`);
  }
  return {
    status: result.alreadyRunning ? 'already_running' : 'launched',
    url: result.url,
    port: result.port,
    logFile,
  };
}

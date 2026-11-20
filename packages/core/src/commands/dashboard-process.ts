/**
 * Dashboard server process management.
 * PID file operations, health probes, and running server detection.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getDataDir } from '../core/index.js';
import { warn } from '../core/logger.js';

const MODULE = 'dashboard-server';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface DashboardServerInfo {
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
  lastBrowserOpenedAt?: string;
}

// ── PID File Management ────────────────────────────────────────────────────────

export function getDashboardPidPath(): string {
  return path.join(getDataDir(), 'dashboard-server.pid');
}

export function writeDashboardServerInfo(info: DashboardServerInfo): void {
  fs.writeFileSync(getDashboardPidPath(), JSON.stringify(info), { mode: 0o600 });
}

export function readDashboardServerInfo(): DashboardServerInfo | null {
  try {
    const content = fs.readFileSync(getDashboardPidPath(), 'utf8');
    const parsed = JSON.parse(content);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof parsed.pid !== 'number' ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.port !== 'number' ||
      typeof parsed.startedAt !== 'string'
    ) {
      warn(MODULE, 'PID file has invalid structure, ignoring');
      return null;
    }
    if (parsed.lastBrowserOpenedAt !== undefined && typeof parsed.lastBrowserOpenedAt !== 'string') {
      delete parsed.lastBrowserOpenedAt;
    }
    return parsed as DashboardServerInfo;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn(MODULE, `Failed to read PID file: ${(err as Error).message}`);
    }
    return null;
  }
}

/**
 * Stamp the PID file with the current time as `lastBrowserOpenedAt`. Used by
 * startup to throttle re-opening the dashboard tab — see the `shouldOpenBrowser`
 * helper in `startup.ts`. No-ops if the PID file is missing or the recorded
 * port doesn't match (server may have restarted between read and write).
 */
export function recordBrowserOpened(port: number): void {
  const info = readDashboardServerInfo();
  if (!info || info.port !== port) return;
  try {
    writeDashboardServerInfo({ ...info, lastBrowserOpenedAt: new Date().toISOString() });
  } catch (err) {
    warn(MODULE, `Failed to record browser-opened timestamp: ${(err as Error).message}`);
  }
}

export function removeDashboardServerInfo(): void {
  try {
    fs.unlinkSync(getDashboardPidPath());
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn(MODULE, `Failed to remove PID file: ${(err as Error).message}`);
    }
  }
}

/**
 * Remove the PID file only when it records this process. A server that lost
 * the file to a newer server (it was probed as dead, then replaced) must not
 * delete the replacement's PID file on its own shutdown (#1927).
 */
export function removeOwnDashboardServerInfo(): void {
  if (readDashboardServerInfo()?.pid === process.pid) removeDashboardServerInfo();
}

// ── Health Probe ───────────────────────────────────────────────────────────────

/** Our health reply is a few dozen bytes; anything larger is another program. */
const MAX_HEALTH_BODY_LENGTH = 1024;

/** The `pid` field of a health reply, or undefined when the body is not ours. */
function parseHealthPid(body: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  return (parsed as { pid?: unknown } | null)?.pid;
}

/**
 * Probe GET /api/health, which sits outside the rate limiters and reloads no
 * state: the old probe of /api/data read a busy or throttled server as dead
 * (#1927). The server counts as ours only when the reply names the PID the
 * PID file records, so another program listening on the port (or a recycled
 * PID) never passes as the dashboard.
 */
export function isDashboardServerRunning(port: number, pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/health`, { timeout: 2000 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_HEALTH_BODY_LENGTH) {
          resolve(false);
          req.destroy();
        }
      });
      res.on('end', () => resolve(parseHealthPid(body) === pid));
      res.on('error', () => resolve(false));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
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
      warn(MODULE, `Unexpected error checking PID ${info.pid}: ${(err as Error).message}`);
    }
    // ESRCH = no process at that PID; EPERM = PID recycled to another user's process
    // Either way, our dashboard server is no longer running — clean up stale PID file
    removeDashboardServerInfo();
    return null;
  }

  // Process exists — verify it's actually our server via HTTP probe
  if (await isDashboardServerRunning(info.port, info.pid)) {
    return { port: info.port, url: `http://oss.localhost:${info.port}` };
  }

  // Process exists but is not answering as our server on the expected port:
  // stale. Never signal it. The PID file outlives crashes and reboots, so the
  // PID may have been recycled to an unrelated process (#1927).
  removeDashboardServerInfo();
  return null;
}

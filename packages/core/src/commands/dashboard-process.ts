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
    return parsed as DashboardServerInfo;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      warn(MODULE, `Failed to read PID file: ${(err as Error).message}`);
    }
    return null;
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

// ── Health Probe ───────────────────────────────────────────────────────────────

export function isDashboardServerRunning(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/api/data`, { timeout: 2000 }, (res) => {
      // Consume response data to free up memory
      res.resume();
      resolve(res.statusCode === 200);
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
  if (await isDashboardServerRunning(info.port)) {
    return { port: info.port, url: `http://oss.localhost:${info.port}` };
  }

  // Process exists but not responding on expected port — stale
  removeDashboardServerInfo();
  return null;
}

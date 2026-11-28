/**
 * Dashboard server process management.
 * PID file operations, health probes, and running server detection.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
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

/**
 * What the PID file points at. `unverified` means the recorded PID is alive
 * but did not answer `/api/health` as ours: a recycled PID, a server too busy
 * to answer within the timeout, or a server from before 3.43.0, which has no
 * health route (#1882). The PID file is left in place for the caller to decide.
 */
export type DashboardServerProbe =
  | { status: 'none' }
  | { info: DashboardServerInfo; status: 'running'; port: number; url: string }
  | { status: 'unverified'; info: DashboardServerInfo };

export async function probeDashboardServer(): Promise<DashboardServerProbe> {
  const info = readDashboardServerInfo();
  if (!info) return { status: 'none' };

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
    return { status: 'none' };
  }

  // Process exists — verify it's actually our server via HTTP probe
  if (await isDashboardServerRunning(info.port, info.pid)) {
    return { info, status: 'running', port: info.port, url: `http://oss.localhost:${info.port}` };
  }
  return { status: 'unverified', info };
}

export async function findRunningDashboardServer(): Promise<{ port: number; url: string } | null> {
  const probe = await probeDashboardServer();
  if (probe.status === 'running') return { port: probe.port, url: probe.url };

  // Process exists but is not answering as our server on the expected port:
  // stale. Never signal it. The PID file outlives crashes and reboots, so the
  // PID may have been recycled to an unrelated process (#1927).
  if (probe.status === 'unverified') removeDashboardServerInfo();
  return null;
}

const PS_PATHS = ['/bin/ps', '/usr/bin/ps'];

/** The CLI entries a server is started from: the bundle, a source entry, or the npm bin. */
const EVAL_FLAGS = new Set(['-e', '--eval', '-p', '--print']);
const CLI_ENTRY = /^(?:cli\.(?:bundle\.cjs|ts|js)|oss-autopilot)$/;

/**
 * True only for the command line the launchers spawn: `node [--flags] <cli
 * entry> dashboard serve ...`. Matching "dashboard serve" anywhere in argv
 * would accept a recycled PID now running e.g. `grep -rn "dashboard serve"`
 * or a shell wrapper. Anything else, including paths with spaces and a tsx
 * dev server, reads as false, which only ever means "never signal".
 */
export function isDashboardServeCommand(command: string): boolean {
  const tokens = command.trim().split(/\s+/);
  if (!/^node(?:js)?$/.test(path.basename(tokens[0]))) return false;
  let i = 1;
  while (tokens[i]?.startsWith('-')) {
    // With -e / -p the next token is code, not the script.
    if (EVAL_FLAGS.has(tokens[i].split('=', 1)[0])) return false;
    i++;
  }
  return (
    i + 2 < tokens.length &&
    CLI_ENTRY.test(path.basename(tokens[i])) &&
    tokens[i + 1] === 'dashboard' &&
    tokens[i + 2] === 'serve'
  );
}

/**
 * True only when the process at `pid` is a `dashboard serve` process, read
 * from its command line (see isDashboardServeCommand). This is what lets a
 * caller signal a server that does not answer `/api/health` (#1882) without
 * ever signalling a PID that was recycled to an unrelated program (#1927).
 * Anything that cannot be checked (no `ps`, as on Windows, or an exited PID)
 * reads as false.
 */
export function isDashboardServeProcess(pid: number): boolean {
  // An absolute path, so a `ps` earlier on PATH cannot answer for it.
  const ps = PS_PATHS.find((candidate) => fs.existsSync(candidate));
  if (!ps) return false;
  try {
    const command = execFileSync(ps, ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return isDashboardServeCommand(command);
  } catch {
    return false;
  }
}

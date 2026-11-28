/**
 * Socket-level tests for the dashboard server (#1940).
 *
 * dashboard-server.test.ts replaces `http.createServer` with a mock and calls
 * the request handler directly, so it cannot see the bind address, the port
 * retry loop, which limiter guards which route, or the bytes a client
 * receives. This suite starts the real server on loopback, with the real
 * RateLimiter and a real StateManager under the isolated test home, and talks
 * to it over HTTP.
 *
 * The only mock wraps `http.createServer` to keep a handle on the server:
 * `startDashboardServer` does not return it, and each test must close it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import path from 'node:path';

const startedServers = vi.hoisted((): import('node:http').Server[] => []);

vi.mock('node:http', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:http')>();
  return {
    ...actual,
    createServer: (handler: import('node:http').RequestListener) => {
      const server = actual.createServer(handler);
      startedServers.push(server);
      return server;
    },
  };
});

import { getStateManager, resetStateManager } from '../core/index.js';
import { validateDashboardData } from '../core/dashboard-data-schema.js';
import { makeDailyDigest, makeFetchedPR } from '../core/test-utils.js';
import {
  startDashboardServer,
  getDashboardPidPath,
  readDashboardServerInfo,
  writeDashboardServerInfo,
} from './dashboard-server.js';

// ── Loopback helpers ──────────────────────────────────────────────────

const MAX_PORT = 65_535;
const SIGNALS = ['SIGINT', 'SIGTERM'] as const;
const WINDOW_MS = 60_000;

/** Throwaway servers holding ports; closed after each test. */
const portHolders: net.Server[] = [];

/** Listen on a loopback port (0 = any free one); null when it is taken. */
function listenLoopback(port: number): Promise<net.Server | null> {
  if (port > MAX_PORT) return Promise.resolve(null);
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(null));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server: net.Server | null): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

function portOf(server: net.Server | undefined): number {
  const address = server?.address();
  if (!address || typeof address === 'string') throw new Error('server is not listening on a TCP port');
  return address.port;
}

/** Try to hold `count` ports starting at an OS-chosen base; null if any is taken. */
async function tryHoldRun(count: number): Promise<{ base: number; holders: net.Server[] } | null> {
  const first = await listenLoopback(0);
  if (!first) return null;
  const base = portOf(first);
  const offsets = Array.from({ length: count - 1 }, (_, index) => index + 1);
  const rest = await Promise.all(offsets.map((offset) => listenLoopback(base + offset)));
  const holders = [first, ...rest];
  if (holders.every((holder) => holder !== null)) return { base, holders };
  await Promise.all(holders.map((holder) => closeServer(holder)));
  return null;
}

/**
 * Hold `count` consecutive loopback ports, so a test decides exactly which
 * retry candidates are taken: it releases the ones the server may bind.
 */
async function holdConsecutivePorts(count: number): Promise<{ base: number; holders: net.Server[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const run = await tryHoldRun(count);
    if (run) {
      portHolders.push(...run.holders);
      return run;
    }
  }
  throw new Error(
    'no run of ' + count + ' consecutive free loopback ports in 20 attempts (ports taken or base near 65535)',
  );
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface SendOptions {
  headers?: Record<string, string>;
  body?: string;
}

/** One HTTP round trip to 127.0.0.1 on its own connection. Host defaults to an allowed value. */
function send(port: number, method: string, urlPath: string, options: SendOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const headers = { host: 'localhost:' + port, ...options.headers };
    const req = http.request({ port, method, headers, host: '127.0.0.1', path: urlPath, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

async function statusOf(port: number, method: string, urlPath: string): Promise<number> {
  const reply = await send(port, method, urlPath);
  return reply.status;
}

/** Send `count` identical requests one after another; returns the status codes. */
async function sendTimes(count: number, port: number, method: string, urlPath: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let sent = 0; sent < count; sent++) {
    statuses.push(await statusOf(port, method, urlPath));
  }
  return statuses;
}

function repeated(status: number, count: number): number[] {
  return Array.from({ length: count }, () => status);
}

/** Stands in for the shutdown handler's force-exit timer, so it never fires. */
const idleTimer = { unref: () => undefined };

/**
 * Run the SIGTERM handler a server added since `before` was read, with the
 * force-exit timer stubbed and process.exit spied; resolves once the server
 * has closed and the handler asked to exit.
 */
async function shutDownServer(before: ReturnType<typeof process.listeners>): Promise<void> {
  const exit = vi.spyOn(process, 'exit').mockReturnValue(undefined as never);
  const added = process.listeners('SIGTERM').filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  const timer = vi.spyOn(globalThis, 'setTimeout').mockReturnValue(idleTimer as never);
  try {
    added[0]('SIGTERM');
  } finally {
    timer.mockRestore();
  }
  await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
}

// ── Suite ─────────────────────────────────────────────────────────────

/** The waiting-on-maintainer PR in the seeded digest; shelving it sticks. */
const WAITING_PR_URL = 'https://github.com/other/project/pull/2';

/**
 * The limited route classes and their documented per-minute budgets. The
 * POSTs carry no Origin, so an in-budget request stops at the origin check
 * with 403 after its limiter has counted it.
 */
const LIMITED_ROUTES = [
  { name: 'GET /api/data', method: 'GET', urlPath: '/api/data', budget: 30, inBudgetStatus: 200 },
  { name: 'POST /api/action', method: 'POST', urlPath: '/api/action', budget: 10, inBudgetStatus: 403 },
  { name: 'POST /api/refresh', method: 'POST', urlPath: '/api/refresh', budget: 6, inBudgetStatus: 403 },
];

describe('dashboard server over a real loopback socket (#1940)', { timeout: 30_000 }, () => {
  let assetsDir: string;
  let signalListeners: Array<ReturnType<typeof process.listeners>>;
  let now: number;

  /** Start the real server asking for `requestedPort`; returns the port it bound. */
  async function startDashboard(requestedPort: number): Promise<number> {
    await startDashboardServer({ assetsDir, port: requestedPort, token: null, open: false });
    return portOf(startedServers.at(-1));
  }

  /** Start on a port that was free a moment ago. */
  async function startOnFreePort(): Promise<number> {
    const { base, holders } = await holdConsecutivePorts(1);
    await closeServer(holders[0]);
    return startDashboard(base);
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // The limiters read Date.now; the tests move it instead of sleeping.
    now = Date.parse('2030-01-01T00:00:00Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);

    assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-hardening-'));
    fs.writeFileSync(path.join(assetsDir, 'index.html'), '<html></html>');
    signalListeners = SIGNALS.map((signal) => process.listeners(signal));

    resetStateManager();
    const openPRs = [
      makeFetchedPR({ number: 1, status: 'needs_addressing' }),
      makeFetchedPR({ number: 2, repo: 'other/project' }),
    ];
    getStateManager().setLastDigest(
      makeDailyDigest({
        openPRs,
        needsAddressingPRs: [openPRs[0]],
        waitingOnMaintainerPRs: [openPRs[1]],
        summary: { totalActivePRs: 2, totalNeedingAttention: 1, totalMergedAllTime: 0, mergeRate: 0 },
      }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const server of startedServers) server.closeAllConnections();
    const servers = [...startedServers.splice(0), ...portHolders.splice(0)];
    await Promise.all(servers.map((server) => closeServer(server)));
    // startDashboardServer registers shutdown handlers it never removes.
    for (const [index, signal] of SIGNALS.entries()) {
      const added = process.listeners(signal).filter((listener) => !signalListeners[index].includes(listener));
      for (const listener of added) process.removeListener(signal, listener);
    }
    fs.rmSync(getDashboardPidPath(), { force: true });
    fs.rmSync(assetsDir, { recursive: true, force: true });
    resetStateManager();
  });

  describe('bind address', () => {
    it('listens on the IPv4 loopback address only', async () => {
      const port = await startOnFreePort();

      // 0.0.0.0, :: or an omitted host would expose the server to the network;
      // the Host, Origin and CSRF checks all assume a loopback-only listener.
      expect(startedServers).toHaveLength(1);
      expect(startedServers[0].address()).toEqual({ address: '127.0.0.1', family: 'IPv4', port });
    });
  });

  describe('per-route rate limiters', () => {
    it.each(LIMITED_ROUTES)(
      '$name allows $budget requests per minute, then answers 429 until the window passes',
      async ({ method, urlPath, budget, inBudgetStatus }) => {
        const port = await startOnFreePort();

        expect(await sendTimes(budget, port, method, urlPath)).toEqual(repeated(inBudgetStatus, budget));

        const limited = await send(port, method, urlPath);
        expect(limited.status).toBe(429);
        expect(limited.headers['retry-after']).toBe('60');
        expect(JSON.parse(limited.body)).toEqual({ error: 'Too many requests' });

        now += WINDOW_MS - 1;
        const stillLimited = await send(port, method, urlPath);
        expect(stillLimited.status).toBe(429);
        expect(stillLimited.headers['retry-after']).toBe('1');

        now += 1;
        const recovered = await send(port, method, urlPath);
        expect(recovered.status).toBe(inBudgetStatus);
      },
    );

    it('gives each route its own budget and leaves /api/health unlimited', async () => {
      const port = await startOnFreePort();
      const [data, action, refresh] = LIMITED_ROUTES;

      // More health probes than any budget: none is counted against a route.
      expect(await sendTimes(data.budget + 1, port, 'GET', '/api/health')).toEqual(repeated(200, data.budget + 1));

      // Exhausting one route leaves the others in budget.
      await sendTimes(data.budget, port, data.method, data.urlPath);
      expect(await statusOf(port, data.method, data.urlPath)).toBe(429);
      expect(await statusOf(port, action.method, action.urlPath)).toBe(action.inBudgetStatus);
      expect(await statusOf(port, refresh.method, refresh.urlPath)).toBe(refresh.inBudgetStatus);

      await sendTimes(action.budget - 1, port, action.method, action.urlPath);
      expect(await statusOf(port, action.method, action.urlPath)).toBe(429);
      expect(await statusOf(port, refresh.method, refresh.urlPath)).toBe(refresh.inBudgetStatus);

      await sendTimes(refresh.budget - 2, port, refresh.method, refresh.urlPath);
      expect(await statusOf(port, refresh.method, refresh.urlPath)).toBe(429);

      // Every limiter is exhausted; the liveness probe still answers (#1927).
      const health = await send(port, 'GET', '/api/health');
      expect(health.status).toBe(200);
      expect(JSON.parse(health.body)).toEqual({ ok: true, pid: process.pid });
    });
  });

  // Exact-port assertions need a just-released port to stay free until the
  // server binds it; another process can win that race, so retry the test.
  describe('port retry', { retry: 2 }, () => {
    it('moves past ports in use and wires the PID file, Host and Origin checks to the bound port', async () => {
      const { base, holders } = await holdConsecutivePorts(3);
      await closeServer(holders[2]);

      const port = await startDashboard(base);

      expect(port).toBe(base + 2);
      expect(readDashboardServerInfo()).toMatchObject({ pid: process.pid, port });

      // Host: the requested port is not this server; the bound port is.
      const staleHost = await send(port, 'GET', '/api/data', { headers: { host: 'localhost:' + base } });
      expect(staleHost.status).toBe(403);
      expect(JSON.parse(staleHost.body)).toEqual({ error: 'Invalid host' });
      const data = await send(port, 'GET', '/api/data');
      expect(data.status).toBe(200);

      // Origin: same rule. A request that passes origin and CSRF reaches the
      // body parser, which rejects the empty body.
      const csrf = { 'x-csrf-token': String(data.headers['x-csrf-token']) };
      const staleOrigin = await send(port, 'POST', '/api/action', {
        headers: { ...csrf, origin: 'http://localhost:' + base },
      });
      expect(staleOrigin.status).toBe(403);
      expect(JSON.parse(staleOrigin.body)).toEqual({ error: 'Invalid origin' });
      const boundOrigin = await send(port, 'POST', '/api/action', {
        headers: { ...csrf, origin: 'http://localhost:' + port },
      });
      expect(boundOrigin.status).toBe(400);
      expect(JSON.parse(boundOrigin.body)).toEqual({ error: 'Invalid JSON body' });
    });

    it('binds the tenth candidate when the first nine are in use', async () => {
      const { base, holders } = await holdConsecutivePorts(10);
      await closeServer(holders[9]);

      expect(await startDashboard(base)).toBe(base + 9);
    });

    it('fails without trying an eleventh port when all ten candidates are in use', async () => {
      const { base, holders } = await holdConsecutivePorts(11);
      await closeServer(holders[10]);

      await expect(startDashboard(base)).rejects.toThrow(/^Failed to start server: .*EADDRINUSE/);

      expect(startedServers).toHaveLength(1);
      expect(startedServers[0].listening).toBe(false);
      expect(readDashboardServerInfo()).toBeNull();
    });
  });

  describe('clean shutdown (#1927)', () => {
    const sigterm = SIGNALS.indexOf('SIGTERM');

    it('removes the PID file this server recorded', async () => {
      await startOnFreePort();
      expect(readDashboardServerInfo()?.pid).toBe(process.pid);

      await shutDownServer(signalListeners[sigterm]);

      expect(readDashboardServerInfo()).toBeNull();
    });

    it('leaves the PID file of a newer server that replaced this one', async () => {
      const port = await startOnFreePort();
      const newer = { pid: process.pid + 1, port, startedAt: '2030-01-01T00:00:00.000Z' };
      writeDashboardServerInfo(newer);

      await shutDownServer(signalListeners[sigterm]);

      expect(readDashboardServerInfo()).toMatchObject(newer);
    });
  });

  describe('payload schema', () => {
    it('GET /api/data returns a body the SPA schema accepts without dropping a field', async () => {
      const port = await startOnFreePort();

      const reply = await send(port, 'GET', '/api/data');
      expect(reply.status).toBe(200);
      const payload: unknown = JSON.parse(reply.body);
      const validation = validateDashboardData(payload);

      // The SPA throws on a mismatch (use-dashboard.ts) and renders the parsed
      // value, so a key the schema does not know is lost just like a missing one.
      expect(validation).toEqual({ ok: true, data: payload });
      expect(validation).toMatchObject({ data: { stats: { activePRs: 2 }, activePRs: [{}, {}] } });
    });

    it('POST /api/action returns the same contract after a real mutation', async () => {
      const port = await startOnFreePort();
      const data = await send(port, 'GET', '/api/data');

      const reply = await send(port, 'POST', '/api/action', {
        headers: { origin: 'http://localhost:' + port, 'x-csrf-token': String(data.headers['x-csrf-token']) },
        body: JSON.stringify({ action: 'move', url: WAITING_PR_URL, target: 'shelved' }),
      });
      expect(reply.status).toBe(200);
      const payload: unknown = JSON.parse(reply.body);

      expect(validateDashboardData(payload)).toEqual({ ok: true, data: payload });
      expect(payload).toMatchObject({ shelvedPRUrls: [WAITING_PR_URL], stats: { activePRs: 1, shelvedPRs: 1 } });
    });
  });
});

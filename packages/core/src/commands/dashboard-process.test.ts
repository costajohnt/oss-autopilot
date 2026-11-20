/**
 * Tests for dashboard-process.ts focused on PID file shape, the
 * `recordBrowserOpened` helper added for #1339, and the liveness probe (#1927).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../core/index.js', () => ({
  getDataDir: () => process.env.__OSS_TEST_DATA_DIR ?? os.tmpdir(),
}));

// The probe is driven through a mocked http.get so no test opens a socket.
const mockHttpGet = vi.fn();
vi.mock('node:http', () => ({ get: (...args: unknown[]) => mockHttpGet(...args) }));

const {
  writeDashboardServerInfo,
  readDashboardServerInfo,
  recordBrowserOpened,
  getDashboardPidPath,
  removeOwnDashboardServerInfo,
  isDashboardServerRunning,
  findRunningDashboardServer,
} = await import('./dashboard-process.js');

/** Answer the next probe with this HTTP status, or with a connection error when null. */
function stubProbe(statusCode: number | null): void {
  mockHttpGet.mockImplementation((_url: string, _options: unknown, onResponse: (res: unknown) => void) => {
    if (statusCode !== null) queueMicrotask(() => onResponse({ statusCode, resume: vi.fn() }));
    return {
      on: (event: string, listener: () => void) => {
        if (event === 'error' && statusCode === null) queueMicrotask(listener);
      },
    };
  });
}

describe('dashboard-process PID file', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-pidtest-'));
    process.env.__OSS_TEST_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__OSS_TEST_DATA_DIR;
  });

  it('round-trips lastBrowserOpenedAt through write/read', () => {
    const ts = '2026-05-09T12:34:56.000Z';
    writeDashboardServerInfo({
      pid: 1234,
      port: 3000,
      startedAt: '2026-05-09T12:00:00.000Z',
      version: '3.6.0',
      lastBrowserOpenedAt: ts,
    });

    const info = readDashboardServerInfo();
    expect(info?.lastBrowserOpenedAt).toBe(ts);
  });

  it('drops a non-string lastBrowserOpenedAt rather than rejecting the whole file', () => {
    fs.writeFileSync(
      getDashboardPidPath(),
      JSON.stringify({
        pid: 1234,
        port: 3000,
        startedAt: '2026-05-09T12:00:00.000Z',
        lastBrowserOpenedAt: 12_345, // wrong type
      }),
    );

    const info = readDashboardServerInfo();
    expect(info).not.toBeNull();
    expect(info?.lastBrowserOpenedAt).toBeUndefined();
    expect(info?.pid).toBe(1234);
  });
});

describe('recordBrowserOpened', () => {
  let tmpDir: string;
  const fixedNow = new Date('2026-05-09T15:00:00.000Z');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-pidtest-'));
    process.env.__OSS_TEST_DATA_DIR = tmpDir;
    vi.useFakeTimers();
    vi.setSystemTime(fixedNow);
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__OSS_TEST_DATA_DIR;
  });

  it('stamps the PID file with the current ISO timestamp', () => {
    writeDashboardServerInfo({
      pid: 1234,
      port: 3000,
      startedAt: '2026-05-09T12:00:00.000Z',
    });

    recordBrowserOpened(3000);

    const info = readDashboardServerInfo();
    expect(info?.lastBrowserOpenedAt).toBe(fixedNow.toISOString());
  });

  it('no-ops when the PID file is missing', () => {
    expect(() => recordBrowserOpened(3000)).not.toThrow();
    expect(readDashboardServerInfo()).toBeNull();
  });

  it('no-ops when the recorded port does not match (stale read)', () => {
    writeDashboardServerInfo({
      pid: 1234,
      port: 3000,
      startedAt: '2026-05-09T12:00:00.000Z',
    });

    recordBrowserOpened(9999); // mismatched port

    const info = readDashboardServerInfo();
    expect(info?.lastBrowserOpenedAt).toBeUndefined();
  });
});

describe('liveness probe (#1927)', () => {
  let tmpDir: string;
  let killSpy: ReturnType<typeof vi.spyOn>;
  const otherPid = process.pid + 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-pidtest-'));
    process.env.__OSS_TEST_DATA_DIR = tmpDir;
    mockHttpGet.mockReset();
    // Every PID reads as alive, and no real signal is ever sent.
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    writeDashboardServerInfo({ pid: otherPid, port: 3000, startedAt: '2026-05-09T12:00:00.000Z' });
  });

  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__OSS_TEST_DATA_DIR;
  });

  it('probes /api/health and counts a non-200 response as alive', async () => {
    stubProbe(429);

    expect(await isDashboardServerRunning(3000)).toBe(true);
    expect(mockHttpGet.mock.calls[0][0]).toBe('http://127.0.0.1:3000/api/health');
  });

  it('reads a connection error as not running', async () => {
    stubProbe(null);

    expect(await isDashboardServerRunning(3000)).toBe(false);
  });

  it('keeps a live server that answers the probe with an error status', async () => {
    stubProbe(403);

    expect(await findRunningDashboardServer()).toEqual({ port: 3000, url: 'http://oss.localhost:3000' });
    expect(killSpy).not.toHaveBeenCalledWith(otherPid, 'SIGTERM');
    expect(readDashboardServerInfo()?.pid).toBe(otherPid);
  });

  it('stops a live but unresponsive server before dropping its PID file', async () => {
    stubProbe(null);

    expect(await findRunningDashboardServer()).toBeNull();
    expect(killSpy).toHaveBeenCalledWith(otherPid, 'SIGTERM');
    expect(readDashboardServerInfo()).toBeNull();
  });

  it('removeOwnDashboardServerInfo leaves a PID file recorded by another process', () => {
    removeOwnDashboardServerInfo();

    expect(readDashboardServerInfo()?.pid).toBe(otherPid);
  });

  it('removeOwnDashboardServerInfo removes the PID file this process recorded', () => {
    writeDashboardServerInfo({ pid: process.pid, port: 3000, startedAt: '2026-05-09T12:00:00.000Z' });

    removeOwnDashboardServerInfo();

    expect(readDashboardServerInfo()).toBeNull();
  });
});

/**
 * Tests for dashboard-process.ts focused on PID file shape and the
 * `recordBrowserOpened` helper added for #1339.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../core/index.js', () => ({
  getDataDir: () => process.env.__OSS_TEST_DATA_DIR ?? os.tmpdir(),
}));

const { writeDashboardServerInfo, readDashboardServerInfo, recordBrowserOpened, getDashboardPidPath } =
  await import('./dashboard-process.js');

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
        lastBrowserOpenedAt: 12345, // wrong type
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

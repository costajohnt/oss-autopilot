/**
 * Tests for dashboard-process.ts focused on PID file shape, the
 * `recordBrowserOpened` helper added for #1339, and the liveness probe (#1927).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { PassThrough } from 'node:stream';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

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
  probeDashboardServer,
  isDashboardServeProcess,
  isDashboardServeCommand,
} = await import('./dashboard-process.js');

/** Answer the next probe with this response body, or with a connection error when null. */
function stubProbe(body: string | null): void {
  mockHttpGet.mockImplementation((_url: string, _options: unknown, onResponse: (res: unknown) => void) => {
    if (body !== null) {
      const res = new PassThrough();
      queueMicrotask(() => onResponse(res));
      res.end(body);
    }
    return {
      destroy: vi.fn(),
      on: (event: string, listener: () => void) => {
        if (event === 'error' && body === null) queueMicrotask(listener);
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

  it('probes /api/health and reads a reply naming the recorded PID as alive', async () => {
    stubProbe(JSON.stringify({ ok: true, pid: otherPid }));

    expect(await isDashboardServerRunning(3000, otherPid)).toBe(true);
    expect(mockHttpGet.mock.calls[0][0]).toBe('http://127.0.0.1:3000/api/health');
  });

  it.each([
    ['a different pid', JSON.stringify({ ok: true, pid: otherPid + 1 })],
    ['no pid', JSON.stringify({ ok: true })],
    ['a JSON null body', 'null'],
    ['a non-JSON body', '<html>some other app</html>'],
    ['an oversized body', 'x'.repeat(5000)],
    ['a connection error', null],
  ])('does not take a reply with %s for our server, and never signals the PID', async (_label, body) => {
    stubProbe(body);

    expect(await isDashboardServerRunning(3000, otherPid)).toBe(false);
    expect(await findRunningDashboardServer()).toBeNull();
    expect(killSpy).not.toHaveBeenCalledWith(otherPid, 'SIGTERM');
    expect(readDashboardServerInfo()).toBeNull();
  });

  it('keeps a live server whose health reply names the recorded PID', async () => {
    stubProbe(JSON.stringify({ ok: true, pid: otherPid }));

    expect(await findRunningDashboardServer()).toEqual({ port: 3000, url: 'http://oss.localhost:3000' });
    expect(readDashboardServerInfo()?.pid).toBe(otherPid);
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

describe('probeDashboardServer (#1882)', () => {
  let tmpDir: string;
  let killSpy: ReturnType<typeof vi.spyOn>;
  const otherPid = process.pid + 1;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-pidtest-'));
    process.env.__OSS_TEST_DATA_DIR = tmpDir;
    mockHttpGet.mockReset();
    killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    writeDashboardServerInfo({ pid: otherPid, port: 3000, startedAt: '2026-05-09T12:00:00.000Z', version: '3.42.0' });
  });

  afterEach(() => {
    killSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.__OSS_TEST_DATA_DIR;
  });

  it('reports a live PID that does not answer /api/health as unverified and keeps the PID file', async () => {
    // A pre-3.43 server: no /api/health route, so the probe gets its SPA fallback.
    stubProbe('<html>dashboard</html>');

    const probe = await probeDashboardServer();

    expect(probe).toEqual({ status: 'unverified', info: expect.objectContaining({ pid: otherPid }) });
    expect(readDashboardServerInfo()?.pid).toBe(otherPid);
    expect(killSpy).not.toHaveBeenCalledWith(otherPid, 'SIGTERM');
  });

  it('reports a server that names the recorded PID as running', async () => {
    stubProbe(JSON.stringify({ ok: true, pid: otherPid }));

    expect(await probeDashboardServer()).toMatchObject({ status: 'running', port: 3000 });
  });

  it('reports none and removes the PID file when the PID is gone', async () => {
    killSpy.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    });

    expect(await probeDashboardServer()).toEqual({ status: 'none' });
    expect(readDashboardServerInfo()).toBeNull();
  });
});

describe('isDashboardServeCommand (#1882)', () => {
  it.each([
    ['the bundle', 'node /p/packages/core/dist/cli.bundle.cjs dashboard serve --port 3000 --no-open'],
    ['an absolute node with flags', '/usr/local/bin/node --enable-source-maps /p/dist/cli.bundle.cjs dashboard serve'],
    ['the npm bin', 'node /usr/local/bin/oss-autopilot dashboard serve --port 3000'],
    ['a source entry', 'node /p/packages/core/src/cli.js dashboard serve'],
  ])('accepts %s', (_label, command) => {
    expect(isDashboardServeCommand(command)).toBe(true);
  });

  it.each([
    ['node -e with the words as arguments', 'node -e setInterval(()=>{},1000) dashboard serve'],
    ['node -e whose code looks like an entry', 'node -e /p/cli.bundle.cjs dashboard serve'],
    ['a shell wrapper', 'bash -c sleep 5; echo grep -rn dashboard serve'],
    ['grep for the words', 'grep -rn dashboard serve /p/cli.bundle.cjs'],
    ['a non-node runner of the bundle', 'bun /p/dist/cli.bundle.cjs dashboard serve'],
    ['another subcommand', 'node /p/dist/cli.bundle.cjs dashboard launch'],
    ['another script before the subcommand', 'node /p/other.js /p/dist/cli.bundle.cjs dashboard serve'],
    ['an empty command line', ''],
  ])('rejects %s', (_label, command) => {
    expect(isDashboardServeCommand(command)).toBe(false);
  });
});

describe.skipIf(process.platform === 'win32')('isDashboardServeProcess (#1882)', () => {
  let tmpDir: string;
  let entry: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oss-serve-'));
    entry = path.join(tmpDir, 'cli.bundle.cjs');
    fs.writeFileSync(entry, 'setInterval(() => {}, 1000);\n');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function withChild(command: string, args: string[], check: (pid: number) => void): Promise<void> {
    const child = spawn(command, args);
    try {
      await new Promise((resolve) => child.once('spawn', resolve));
      check(child.pid!);
    } finally {
      child.kill();
    }
  }

  it('identifies `node <tmp>/cli.bundle.cjs dashboard serve`', async () => {
    await withChild(process.execPath, [entry, 'dashboard', 'serve', '--port', '3000'], (pid) => {
      expect(isDashboardServeProcess(pid)).toBe(true);
    });
  });

  it('does not identify `node -e ... dashboard serve`', async () => {
    await withChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'dashboard', 'serve'], (pid) => {
      expect(isDashboardServeProcess(pid)).toBe(false);
    });
  });

  it("does not identify `bash -c '... dashboard serve'`", async () => {
    await withChild('bash', ['-c', 'sleep 5; echo grep -rn dashboard serve'], (pid) => {
      expect(isDashboardServeProcess(pid)).toBe(false);
    });
  });

  it('does not identify a PID with no process', async () => {
    const child = spawn(process.execPath, [entry, 'dashboard', 'serve']);
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));

    expect(isDashboardServeProcess(child.pid!)).toBe(false);
  });
});

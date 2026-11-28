/**
 * Tests for dashboard-lifecycle.ts
 *
 * Strategy: Mock child_process.spawn, dashboard-server functions, and
 * dashboard.resolveAssetsDir to test the primary launch paths without actually
 * starting servers or forking processes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockResolveAssetsDir = vi.fn();
vi.mock('./dashboard.js', () => ({
  resolveAssetsDir: () => mockResolveAssetsDir(),
}));

const mockProbeDashboardServer = vi.fn();
const mockIsDashboardServeProcess = vi.fn();
const mockIsDashboardServerRunning = vi.fn();
const mockReadDashboardServerInfo = vi.fn();
const mockRemoveDashboardServerInfo = vi.fn();
vi.mock('./dashboard-process.js', () => ({
  probeDashboardServer: () => mockProbeDashboardServer(),
  isDashboardServeProcess: (pid: number) => mockIsDashboardServeProcess(pid),
  isDashboardServerRunning: (port: number, pid: number) => mockIsDashboardServerRunning(port, pid),
  readDashboardServerInfo: () => mockReadDashboardServerInfo(),
  removeDashboardServerInfo: () => mockRemoveDashboardServerInfo(),
}));

const mockGetCLIVersion = vi.fn().mockReturnValue('0.44.6');
const mockGetDataDir = vi.fn().mockReturnValue('/tmp');
vi.mock('../core/index.js', () => ({
  getCLIVersion: () => mockGetCLIVersion(),
  getDataDir: () => mockGetDataDir(),
}));

interface ServerInfo {
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
}

/** The PID file names a server that answers /api/health as ours. */
function runningServer(info: ServerInfo): void {
  mockProbeDashboardServer.mockResolvedValue({
    status: 'running',
    info,
    port: info.port,
    url: `http://oss.localhost:${info.port}`,
  });
}

/** The PID file names a live PID that does not answer /api/health as ours. */
function unverifiedServer(info: ServerInfo): void {
  mockProbeDashboardServer.mockResolvedValue({ status: 'unverified', info });
}

// ── Import after mocks ──────────────────────────────────────────────

const { launchDashboardServer, resolveCliEntry, stopStaleDashboardServer, runDashboardLaunch } =
  await import('./dashboard-lifecycle.js');
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');

describe('resolveCliEntry (#1735)', () => {
  it('keeps argv[1] when it is the core CLI entry', () => {
    expect(resolveCliEntry('/x/core/dist/cli.bundle.cjs', '/nowhere/dashboard/dist')).toBe(
      '/x/core/dist/cli.bundle.cjs',
    );
    expect(resolveCliEntry('/x/core/src/cli.ts', '/nowhere/dashboard/dist')).toBe('/x/core/src/cli.ts');
  });

  it('uses the core bundle beside the assets when another host (MCP) is running', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-entry-'));
    try {
      const bundle = path.join(root, 'core', 'dist', 'cli.bundle.cjs');
      fs.mkdirSync(path.dirname(bundle), { recursive: true });
      fs.writeFileSync(bundle, '');
      expect(resolveCliEntry('/x/mcp-server/dist/mcp-server.bundle.cjs', path.join(root, 'dashboard', 'dist'))).toBe(
        bundle,
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back to argv[1] when no core bundle sits beside the assets', () => {
    expect(resolveCliEntry('/x/mcp.bundle.cjs', '/nowhere/dashboard/dist')).toBe('/x/mcp.bundle.cjs');
  });
});

// ── Tests ────────────────────────────────────────────────────────────

describe('launchDashboardServer', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: SPA assets available, no existing server
    mockResolveAssetsDir.mockReturnValue('/path/to/dist');
    mockProbeDashboardServer.mockResolvedValue({ status: 'none' });
    mockIsDashboardServeProcess.mockReturnValue(false);
    mockSpawn.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 99_999 });
    // Mock process.kill to prevent sending real signals to arbitrary PIDs
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
  });

  it('should return null when SPA assets are not available', async () => {
    mockResolveAssetsDir.mockReturnValue(null);

    const result = await launchDashboardServer();

    expect(result).toBeNull();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should stop an old-version server even when SPA assets are missing (#1709)', async () => {
    mockResolveAssetsDir.mockReturnValue(null);
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.4' });
    mockGetCLIVersion.mockReturnValue('0.44.6');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(result).toBeNull();
    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGTERM');
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should leave a same-version server running when SPA assets are missing', async () => {
    mockResolveAssetsDir.mockReturnValue(null);
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.6' });
    mockGetCLIVersion.mockReturnValue('0.44.6');

    expect(await launchDashboardServer()).toBeNull();
    expect(processKillSpy).not.toHaveBeenCalled();
  });

  it('should return existing server when already running with same version', async () => {
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.6' });
    mockGetCLIVersion.mockReturnValue('0.44.6');

    const result = await launchDashboardServer();

    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should return existing server when PID file has no version (backward compat)', async () => {
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });

    const result = await launchDashboardServer();

    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should kill and relaunch server when version mismatches (#548)', async () => {
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.4' });
    // Polling reads the new server's PID file
    mockReadDashboardServerInfo.mockReturnValueOnce({
      pid: 99_999,
      port: 3000,
      startedAt: '2026-01-01T00:00:01Z',
      version: '0.44.6',
    });
    mockGetCLIVersion.mockReturnValue('0.44.6');
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGTERM');
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: false });
  });

  it('should return existing server when kill fails with EPERM (#548)', async () => {
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.4' });
    mockGetCLIVersion.mockReturnValue('0.44.6');
    // Simulate EPERM — PID recycled to another user's process
    const epermErr = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    processKillSpy.mockImplementation(() => {
      throw epermErr;
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    // Should NOT remove PID file when kill failed with EPERM
    expect(mockRemoveDashboardServerInfo).not.toHaveBeenCalled();
    // Should NOT spawn — return existing server rather than a doomed attempt
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: true });
  });

  it('should not kill server when getCLIVersion returns fallback 0.0.0', async () => {
    runningServer({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.4' });
    // getCLIVersion could not read package.json — returns fallback
    mockGetCLIVersion.mockReturnValue('0.0.0');

    const result = await launchDashboardServer();

    // Should NOT kill — unreliable version read
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: true });
  });

  it('should spawn detached child process when no server running', async () => {
    // PID file appears on first poll, server responds on probe
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer();

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['dashboard', 'serve', '--port', '3000', '--no-open']),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(result).toEqual({ url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: false });
  });

  it('should use custom port when specified', async () => {
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12_345, port: 8080, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer({ port: 8080 });

    expect(mockSpawn).toHaveBeenCalledWith('node', expect.arrayContaining(['--port', '8080']), expect.anything());
    expect(result?.port).toBe(8080);
  });

  it('should handle port auto-increment by reading actual port from PID file', async () => {
    // Server auto-incremented from 3000 to 3001
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12_345, port: 3001, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer({ port: 3000 });

    expect(result).toEqual({ url: 'http://oss.localhost:3001', port: 3001, alreadyRunning: false });
  });

  it('should return null on timeout and kill orphan process', async () => {
    // PID file never appears
    mockReadDashboardServerInfo.mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(result).toBeNull();
    // Verify orphan process is killed
    expect(processKillSpy).toHaveBeenCalledWith(99_999, 'SIGTERM');
  }, 10_000); // Longer timeout since it polls for 5s

  it('should return null when PID file appears but server not responding', async () => {
    // PID file appears but health probe always fails
    mockReadDashboardServerInfo.mockReturnValue({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(result).toBeNull();
  }, 10_000);

  it('should unref the child process so parent can exit', async () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValue({ unref: mockUnref, on: vi.fn(), pid: 99_999 });
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    await launchDashboardServer();

    expect(mockUnref).toHaveBeenCalled();
  });

  it('should bail early when spawn emits an error', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      pid: 99_999,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        // queueMicrotask fires on the next microtask — deterministic, no wall-clock
        // dependency, avoids CI-slowness flakes vs a setTimeout (#1004).
        if (event === 'error') queueMicrotask(() => cb(new Error('ENOENT')));
      }),
    });
    mockReadDashboardServerInfo.mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to spawn'));
    consoleSpy.mockRestore();
  });

  it('should bail early when child process exits prematurely', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      pid: 99_999,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') queueMicrotask(() => cb(1));
      }),
    });
    mockReadDashboardServerInfo.mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();

    expect(result).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('exited prematurely'));
    consoleSpy.mockRestore();
  });
});

describe('stopStaleDashboardServer version rules (#1882)', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;
  let consoleSpy: ReturnType<typeof vi.spyOn>;
  const SERVER = { pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' };
  const RUNNING = { url: 'http://oss.localhost:3000', port: 3000, alreadyRunning: true };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetCLIVersion.mockReturnValue('3.43.0');
    mockIsDashboardServeProcess.mockReturnValue(false);
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
    consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it.each([
    ['a newer patch', '3.43.1'],
    ['a newer minor, compared as numbers', '3.100.0'],
  ])('leaves a server from %s running', async (_label, version) => {
    runningServer({ ...SERVER, version });

    expect(await stopStaleDashboardServer()).toEqual(RUNNING);
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockRemoveDashboardServerInfo).not.toHaveBeenCalled();
  });

  it('stops an older server whose minor only sorts higher as a string', async () => {
    runningServer({ ...SERVER, version: '3.9.0' });
    mockGetCLIVersion.mockReturnValue('3.10.0');

    expect(await stopStaleDashboardServer()).toBeNull();
    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGTERM');
  });

  it('stops a pre-3.43 server that has no /api/health route once its command line identifies it', async () => {
    unverifiedServer({ ...SERVER, version: '3.42.1' });
    mockIsDashboardServeProcess.mockReturnValue(true);

    expect(await stopStaleDashboardServer()).toBeNull();
    expect(mockIsDashboardServeProcess).toHaveBeenCalledWith(12_345);
    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGTERM');
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
  });

  it.each([
    ['the same version', '3.43.0'],
    ['no recorded version', undefined],
  ])('stops an identified server with %s that misses the health check, so it is not orphaned', async (_l, version) => {
    unverifiedServer({ ...SERVER, version });
    mockIsDashboardServeProcess.mockReturnValue(true);

    expect(await stopStaleDashboardServer()).toBeNull();
    expect(processKillSpy).toHaveBeenCalledWith(12_345, 'SIGTERM');
  });

  it('never signals an unverified PID whose command line is not `dashboard serve` (#1927)', async () => {
    unverifiedServer({ ...SERVER, version: '3.42.1' });
    mockIsDashboardServeProcess.mockReturnValue(false);

    expect(await stopStaleDashboardServer()).toBeNull();
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
  });

  it('leaves an identified newer server running even when it misses the health check', async () => {
    unverifiedServer({ ...SERVER, version: '3.44.0' });
    mockIsDashboardServeProcess.mockReturnValue(true);

    expect(await stopStaleDashboardServer()).toEqual(RUNNING);
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockRemoveDashboardServerInfo).not.toHaveBeenCalled();
  });

  it('does not signal an unverified PID when the current version is unreadable', async () => {
    unverifiedServer({ ...SERVER, version: '3.42.1' });
    mockIsDashboardServeProcess.mockReturnValue(true);
    mockGetCLIVersion.mockReturnValue('0.0.0');

    expect(await stopStaleDashboardServer()).toBeNull();
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
  });

  it('reports an identified old server as running when the signal fails (EPERM)', async () => {
    unverifiedServer({ ...SERVER, version: '3.42.1' });
    mockIsDashboardServeProcess.mockReturnValue(true);
    processKillSpy.mockImplementation(() => {
      throw Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    });

    expect(await stopStaleDashboardServer()).toEqual(RUNNING);
    expect(mockRemoveDashboardServerInfo).not.toHaveBeenCalled();
  });
});

describe('runDashboardLaunch (#2039)', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;
  let dataDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-launch-'));
    mockGetDataDir.mockReturnValue(dataDir);
    mockGetCLIVersion.mockReturnValue('3.43.0');
    mockResolveAssetsDir.mockReturnValue('/path/to/dist');
    mockProbeDashboardServer.mockResolvedValue({ status: 'none' });
    mockSpawn.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 99_999 });
    processKillSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);
  });

  afterEach(() => {
    processKillSpy.mockRestore();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('reuses a running current-version server', async () => {
    runningServer({ pid: 12_345, port: 3001, startedAt: '2026-01-01T00:00:00Z', version: '3.43.0' });

    expect(await runDashboardLaunch({ port: 3000 })).toEqual({
      status: 'already_running',
      url: 'http://oss.localhost:3001',
      port: 3001,
      logFile: path.join(dataDir, 'dashboard.log'),
    });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('starts a server with its output appended to the log file', async () => {
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12_345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await runDashboardLaunch({ port: 3000 });

    expect(result).toEqual({
      status: 'launched',
      url: 'http://oss.localhost:3000',
      port: 3000,
      logFile: path.join(dataDir, 'dashboard.log'),
    });
    const stdio = mockSpawn.mock.calls[0][2].stdio;
    expect(stdio).toEqual(['ignore', expect.any(Number), expect.any(Number)]);
    expect(fs.readFileSync(path.join(dataDir, 'dashboard.log'), 'utf8')).toMatch(/^--- dashboard server started /);
  });

  it('throws when the SPA assets are missing', async () => {
    mockResolveAssetsDir.mockReturnValue(null);

    await expect(runDashboardLaunch({ port: 3000 })).rejects.toThrow('Dashboard SPA assets not found');
  });

  it('throws naming the log file when the server does not start', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      pid: 99_999,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') queueMicrotask(() => cb(1));
      }),
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(runDashboardLaunch({ port: 3000 })).rejects.toThrow(
      `Dashboard server did not start. Logs: ${path.join(dataDir, 'dashboard.log')}`,
    );
    consoleSpy.mockRestore();
  });
});

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
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

const mockResolveAssetsDir = vi.fn();
vi.mock('./dashboard.js', () => ({
  resolveAssetsDir: () => mockResolveAssetsDir(),
}));

const mockFindRunningDashboardServer = vi.fn();
const mockIsDashboardServerRunning = vi.fn();
const mockReadDashboardServerInfo = vi.fn();
const mockRemoveDashboardServerInfo = vi.fn();
vi.mock('./dashboard-process.js', () => ({
  findRunningDashboardServer: () => mockFindRunningDashboardServer(),
  isDashboardServerRunning: (port: number) => mockIsDashboardServerRunning(port),
  readDashboardServerInfo: () => mockReadDashboardServerInfo(),
  removeDashboardServerInfo: () => mockRemoveDashboardServerInfo(),
}));

const mockGetCLIVersion = vi.fn().mockReturnValue('0.44.6');
vi.mock('../core/index.js', () => ({
  getCLIVersion: () => mockGetCLIVersion(),
}));

// ── Import after mocks ──────────────────────────────────────────────

const { launchDashboardServer } = await import('./dashboard-lifecycle.js');

// ── Tests ────────────────────────────────────────────────────────────

describe('launchDashboardServer', () => {
  let processKillSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: SPA assets available, no existing server
    mockResolveAssetsDir.mockReturnValue('/path/to/dist');
    mockFindRunningDashboardServer.mockResolvedValue(null);
    mockSpawn.mockReturnValue({ unref: vi.fn(), on: vi.fn(), pid: 99999 });
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

  it('should return existing server when already running with same version', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    mockReadDashboardServerInfo.mockReturnValue({
      pid: 12345,
      port: 3000,
      startedAt: '2026-01-01T00:00:00Z',
      version: '0.44.6',
    });
    mockGetCLIVersion.mockReturnValue('0.44.6');

    const result = await launchDashboardServer();

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should return existing server when PID file has no version (backward compat)', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    mockReadDashboardServerInfo.mockReturnValue({ pid: 12345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });

    const result = await launchDashboardServer();

    expect(mockReadDashboardServerInfo).toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('should kill and relaunch server when version mismatches (#548)', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    // First call: version check reads old server info; second call: polling reads new server info
    mockReadDashboardServerInfo
      .mockReturnValueOnce({ pid: 12345, port: 3000, startedAt: '2026-01-01T00:00:00Z', version: '0.44.4' })
      .mockReturnValueOnce({ pid: 99999, port: 3000, startedAt: '2026-01-01T00:00:01Z', version: '0.44.6' });
    mockGetCLIVersion.mockReturnValue('0.44.6');
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(processKillSpy).toHaveBeenCalledWith(12345, 'SIGTERM');
    expect(mockRemoveDashboardServerInfo).toHaveBeenCalled();
    expect(mockSpawn).toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
  });

  it('should return existing server when kill fails with EPERM (#548)', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    mockReadDashboardServerInfo.mockReturnValueOnce({
      pid: 12345,
      port: 3000,
      startedAt: '2026-01-01T00:00:00Z',
      version: '0.44.4',
    });
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
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: true });
  });

  it('should not kill server when getCLIVersion returns fallback 0.0.0', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    mockReadDashboardServerInfo.mockReturnValueOnce({
      pid: 12345,
      port: 3000,
      startedAt: '2026-01-01T00:00:00Z',
      version: '0.44.4',
    });
    // getCLIVersion could not read package.json — returns fallback
    mockGetCLIVersion.mockReturnValue('0.0.0');

    const result = await launchDashboardServer();

    // Should NOT kill — unreliable version read
    expect(processKillSpy).not.toHaveBeenCalled();
    expect(mockSpawn).not.toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: true });
  });

  it('should relaunch when PID file disappears between health check and version read', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });
    // PID file disappeared (race condition)
    mockReadDashboardServerInfo
      .mockReturnValueOnce(null)
      .mockReturnValueOnce({ pid: 99999, port: 3000, startedAt: '2026-01-01T00:00:01Z', version: '0.44.6' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer();

    // Should fall through and spawn a new server
    expect(mockSpawn).toHaveBeenCalled();
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
  });

  it('should spawn detached child process when no server running', async () => {
    // PID file appears on first poll, server responds on probe
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer();

    expect(mockSpawn).toHaveBeenCalledWith(
      'node',
      expect.arrayContaining(['dashboard', 'serve', '--port', '3000', '--no-open']),
      expect.objectContaining({ detached: true, stdio: 'ignore' }),
    );
    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: false });
  });

  it('should use custom port when specified', async () => {
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12345, port: 8080, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer({ port: 8080 });

    expect(mockSpawn).toHaveBeenCalledWith('node', expect.arrayContaining(['--port', '8080']), expect.anything());
    expect(result?.port).toBe(8080);
  });

  it('should handle port auto-increment by reading actual port from PID file', async () => {
    // Server auto-incremented from 3000 to 3001
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12345, port: 3001, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    const result = await launchDashboardServer({ port: 3000 });

    expect(result).toEqual({ url: 'http://localhost:3001', port: 3001, alreadyRunning: false });
  });

  it('should return null on timeout and kill orphan process', async () => {
    // PID file never appears
    mockReadDashboardServerInfo.mockReturnValue(null);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(result).toBeNull();
    // Verify orphan process is killed
    expect(processKillSpy).toHaveBeenCalledWith(99999, 'SIGTERM');
  }, 10000); // Longer timeout since it polls for 5s

  it('should return null when PID file appears but server not responding', async () => {
    // PID file appears but health probe always fails
    mockReadDashboardServerInfo.mockReturnValue({ pid: 12345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValue(false);

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await launchDashboardServer();
    consoleSpy.mockRestore();

    expect(result).toBeNull();
  }, 10000);

  it('should unref the child process so parent can exit', async () => {
    const mockUnref = vi.fn();
    mockSpawn.mockReturnValue({ unref: mockUnref, on: vi.fn(), pid: 99999 });
    mockReadDashboardServerInfo.mockReturnValueOnce({ pid: 12345, port: 3000, startedAt: '2026-01-01T00:00:00Z' });
    mockIsDashboardServerRunning.mockResolvedValueOnce(true);

    await launchDashboardServer();

    expect(mockUnref).toHaveBeenCalled();
  });

  it('should bail early when spawn emits an error', async () => {
    mockSpawn.mockReturnValue({
      unref: vi.fn(),
      pid: 99999,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'error') setTimeout(() => cb(new Error('ENOENT')), 50);
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
      pid: 99999,
      on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
        if (event === 'exit') setTimeout(() => cb(1), 50);
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

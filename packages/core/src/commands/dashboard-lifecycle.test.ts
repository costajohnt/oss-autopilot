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
vi.mock('./dashboard-server.js', () => ({
  findRunningDashboardServer: () => mockFindRunningDashboardServer(),
  isDashboardServerRunning: (port: number) => mockIsDashboardServerRunning(port),
  readDashboardServerInfo: () => mockReadDashboardServerInfo(),
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

  it('should return existing server when already running', async () => {
    mockFindRunningDashboardServer.mockResolvedValue({ port: 3000, url: 'http://localhost:3000' });

    const result = await launchDashboardServer();

    expect(result).toEqual({ url: 'http://localhost:3000', port: 3000, alreadyRunning: true });
    expect(mockSpawn).not.toHaveBeenCalled();
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

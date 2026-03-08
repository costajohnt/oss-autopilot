import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useDashboard } from './use-dashboard';
import { makeDashboardData } from '../test-helpers';
import type { DashboardData } from '../types';

describe('useDashboard', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function mockFetchOk(data: DashboardData) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(data),
    });
  }

  function mockFetchError(status: number, body?: { error: string }) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      json: () => (body ? Promise.resolve(body) : Promise.reject(new Error('no body'))),
    });
  }

  /** Advance past the 5-second auto-refresh delay and flush resulting microtasks. */
  async function triggerAutoRefresh(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
  }

  it('fetches data on mount and transitions from loading to loaded', async () => {
    const data = makeDashboardData();
    mockFetchOk(data);

    const { result } = renderHook(() => useDashboard());

    // Initially loading
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBe(null);

    // Wait for fetch to complete
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toEqual(data);
    expect(result.current.error).toBe(null);
    expect(mockFetch).toHaveBeenCalledWith('/api/data', undefined);
  });

  it('sets error state on fetch failure', async () => {
    mockFetchError(500, { error: 'Internal Server Error' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe('Internal Server Error');
    warnSpy.mockRestore();
  });

  it('sets HTTP status as error when no error body', async () => {
    mockFetchError(502);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('HTTP 502');
    warnSpy.mockRestore();
  });

  it('refresh calls POST /api/refresh', async () => {
    const data = makeDashboardData();
    mockFetchOk(data);

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const refreshedData = makeDashboardData({ stats: { ...data.stats, activePRs: 3 } });
    mockFetchOk(refreshedData);

    await act(async () => {
      await result.current.refresh();
    });

    expect(mockFetch).toHaveBeenLastCalledWith('/api/refresh', { method: 'POST' });
    expect(result.current.data?.stats.activePRs).toBe(3);
  });

  it('performAction sends action and updates data', async () => {
    const data = makeDashboardData();
    mockFetchOk(data);

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    const updatedData = makeDashboardData({ shelvedPRUrls: ['https://github.com/org/repo/pull/1'] });
    mockFetchOk(updatedData);

    await act(async () => {
      await result.current.performAction({
        action: 'move',
        url: 'https://github.com/org/repo/pull/1',
        target: 'shelved',
      });
    });

    expect(mockFetch).toHaveBeenLastCalledWith('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'move', url: 'https://github.com/org/repo/pull/1', target: 'shelved' }),
    });
    expect(result.current.data?.shelvedPRUrls).toEqual(['https://github.com/org/repo/pull/1']);
  });

  it('performAction re-fetches on failure and re-throws', async () => {
    const data = makeDashboardData();
    mockFetchOk(data);

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Action fails
    mockFetchError(500, { error: 'Server error' });
    // Re-fetch succeeds
    const refreshedData = makeDashboardData({ stats: { ...data.stats, activePRs: 4 } });
    mockFetchOk(refreshedData);

    await expect(
      act(async () => {
        await result.current.performAction({ action: 'move', url: 'https://github.com/x/y/pull/1', target: 'shelved' });
      }),
    ).rejects.toThrow('Server error');

    // Data should be refreshed despite the error
    expect(result.current.data?.stats.activePRs).toBe(4);
  });

  it('clearError resets error to null', async () => {
    mockFetchError(500, { error: 'Something went wrong' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.error).toBe('Something went wrong');
    });

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBe(null);
    warnSpy.mockRestore();
  });

  // ── Auto-refresh tests ──────────────────────────────────────────

  it('auto-refreshes after initial load (GET /api/data then POST /api/refresh)', async () => {
    const cached = makeDashboardData();
    const refreshed = makeDashboardData({ stats: { ...cached.stats, mergedPRs: 7 } });
    mockFetchOk(cached);
    mockFetchOk(refreshed);

    const { result } = renderHook(() => useDashboard());

    // Wait for initial fetch
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Advance past the 5s auto-refresh delay
    await triggerAutoRefresh();

    await vi.waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });

    // Verify both calls were made (initial GET + auto POST)
    const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
    expect(calls.some((c) => c[0] === '/api/data')).toBe(true);
    expect(calls.some((c) => c[0] === '/api/refresh' && c[1]?.method === 'POST')).toBe(true);

    // Data updated with refreshed data
    expect(result.current.data?.stats.mergedPRs).toBe(7);
  });

  it('auto-refresh failure preserves cached data and does not set error', async () => {
    const cached = makeDashboardData();
    mockFetchOk(cached);
    mockFetchError(500, { error: 'Refresh failed' });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { result } = renderHook(() => useDashboard());

    // Wait for initial fetch
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Advance past the 5s auto-refresh delay
    await triggerAutoRefresh();

    await vi.waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });

    // Error should NOT be set — cached data preserved
    expect(result.current.error).toBeNull();
    expect(result.current.data?.stats.mergedPRs).toBe(5);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Auto-refresh failed'), expect.any(String));

    warnSpy.mockRestore();
  });

  it('loading stays false during auto-refresh, refreshing is true', async () => {
    const cached = makeDashboardData();
    let resolveRefresh!: (value: unknown) => void;
    const refreshPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    mockFetchOk(cached);
    mockFetch.mockReturnValueOnce(
      refreshPromise.then(() => ({
        ok: true,
        json: () => Promise.resolve(makeDashboardData({ stats: { ...cached.stats, mergedPRs: 10 } })),
      })),
    );

    const { result } = renderHook(() => useDashboard());

    // Wait for initial load
    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    // Advance past the 5s delay to trigger the auto-refresh
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    // During auto-refresh: loading=false, refreshing=true
    await vi.waitFor(() => {
      expect(result.current.refreshing).toBe(true);
    });
    expect(result.current.loading).toBe(false);

    // Complete the refresh
    await act(async () => {
      resolveRefresh(undefined);
      // Allow microtasks to flush
      await new Promise((r) => setTimeout(r, 10));
    });

    await vi.waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });
  });
});

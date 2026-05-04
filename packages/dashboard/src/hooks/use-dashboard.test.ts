import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useDashboard } from './use-dashboard';
import { makeDashboardData } from '../test-helpers';
import type { DashboardData } from '../types';

describe('useDashboard', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Reset call history and mockResolvedValueOnce queue between tests —
    // the mock is module-scoped and would otherwise leak across tests.
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // Default includes an X-CSRF-Token header so the hook's proactive token
  // prime (needed when csrfTokenRef is null on POST) does not require every
  // test to double-mock. Tests that specifically exercise the no-token path
  // pass `null` or a different value.
  function mockFetchOk(data: DashboardData, csrfToken: string | null = 'test-token') {
    const headers = new Headers();
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers,
      json: () => Promise.resolve(data),
    });
  }

  function mockFetchError(status: number, body?: { error: string }) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      headers: new Headers(),
      json: () => (body ? Promise.resolve(body) : Promise.reject(new Error('no body'))),
    });
  }

  /** Advance past the 5-second auto-refresh delay and flush resulting microtasks. */
  async function triggerAutoRefresh(): Promise<void> {
    await act(async () => {
      vi.advanceTimersByTime(5000);
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

    expect(mockFetch).toHaveBeenLastCalledWith('/api/refresh', {
      method: 'POST',
      headers: { 'X-CSRF-Token': 'test-token' },
    });
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
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
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
      vi.advanceTimersByTime(5000);
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
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    await vi.waitFor(() => {
      expect(result.current.refreshing).toBe(false);
    });
  });

  // ── CSRF token (#1031) ────────────────────────────────────────

  describe('CSRF token handling', () => {
    // Real timers here — the auto-refresh cascade under fake timers consumed
    // mocks unpredictably and masked the actual behavior under test.
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('attaches X-CSRF-Token from the last /api/data response to POST /api/action', async () => {
      const data = makeDashboardData();
      mockFetchOk(data, 'server-token-abc123');
      const updated = makeDashboardData({ shelvedPRUrls: ['https://github.com/o/r/pull/1'] });
      mockFetchOk(updated, 'server-token-abc123');

      const { result } = renderHook(() => useDashboard());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.performAction({
          action: 'move',
          url: 'https://github.com/o/r/pull/1',
          target: 'shelved',
        });
      });

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/action',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ 'X-CSRF-Token': 'server-token-abc123' }),
        }),
      );
    });

    it('recovers from a stale token by re-priming via /api/data and retrying once', async () => {
      // Scenario: server restarted and minted a new CSRF token while the SPA
      // still had the old one cached. First POST returns 403 "CSRF token".
      // The hook re-fetches /api/data (picking up the new token) and retries
      // the POST, which now succeeds.
      const data = makeDashboardData();
      const updated = makeDashboardData({ shelvedPRUrls: ['https://github.com/o/r/pull/1'] });

      // Mock 1: mount GET /api/data → caches stale token
      mockFetchOk(data, 'stale-token');
      // Mock 2: first POST /api/action → 403 "CSRF token"
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 403,
        headers: new Headers(),
        json: () => Promise.resolve({ error: 'Missing or invalid CSRF token' }),
      });
      // Mock 3: re-prime GET /api/data → returns fresh token
      mockFetchOk(data, 'fresh-token');
      // Mock 4: retry POST /api/action → success
      mockFetchOk(updated, 'fresh-token');

      const { result } = renderHook(() => useDashboard());
      await vi.waitFor(() => expect(result.current.loading).toBe(false));

      await act(async () => {
        await result.current.performAction({
          action: 'move',
          url: 'https://github.com/o/r/pull/1',
          target: 'shelved',
        });
      });

      const calls = mockFetch.mock.calls as Array<[string, RequestInit?]>;
      const actionPosts = calls.filter((c) => c[0] === '/api/action');
      expect(actionPosts).toHaveLength(2);

      const firstHeaders = actionPosts[0]![1]?.headers as Record<string, string> | undefined;
      expect(firstHeaders?.['X-CSRF-Token']).toBe('stale-token');
      const retryHeaders = actionPosts[1]![1]?.headers as Record<string, string> | undefined;
      expect(retryHeaders?.['X-CSRF-Token']).toBe('fresh-token');

      // Retry's response wins — data state reflects the successful POST.
      expect(result.current.data?.shelvedPRUrls).toEqual(['https://github.com/o/r/pull/1']);
      expect(result.current.error).toBe(null);
    });
  });

  // ── #1050 runtime schema validation ───────────────────────────────────

  describe('schema validation (#1050)', () => {
    it('surfaces an error when /api/data returns a malformed shape (missing stats)', async () => {
      // Response is well-formed JSON but missing the required `stats` field —
      // previously would have committed to state and crashed at render time.
      const malformed = { ...makeDashboardData(), stats: undefined };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve(malformed),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useDashboard());
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.data).toBe(null);
      expect(result.current.error).toMatch(/server response did not match expected shape/i);
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('schema validation failed'),
        expect.any(String),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it('rejects a null response as malformed', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        headers: new Headers(),
        json: () => Promise.resolve(null),
      });
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const { result } = renderHook(() => useDashboard());
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });

      expect(result.current.error).toMatch(/server response did not match expected shape/i);
      consoleSpy.mockRestore();
    });
  });
});

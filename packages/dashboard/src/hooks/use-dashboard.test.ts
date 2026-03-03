import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useDashboard } from './use-dashboard';
import { makeDashboardData } from '../test-helpers';
import type { DashboardData } from '../types';

describe('useDashboard', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
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

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).toBe(null);
    expect(result.current.error).toBe('Internal Server Error');
  });

  it('sets HTTP status as error when no error body', async () => {
    mockFetchError(502);

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe('HTTP 502');
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
      await result.current.performAction({ action: 'shelve', url: 'https://github.com/org/repo/pull/1' });
    });

    expect(mockFetch).toHaveBeenLastCalledWith('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'shelve', url: 'https://github.com/org/repo/pull/1' }),
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
        await result.current.performAction({ action: 'shelve', url: 'https://github.com/x/y/pull/1' });
      }),
    ).rejects.toThrow('Server error');

    // Data should be refreshed despite the error
    expect(result.current.data?.stats.activePRs).toBe(4);
  });

  it('clearError resets error to null', async () => {
    mockFetchError(500, { error: 'Something went wrong' });

    const { result } = renderHook(() => useDashboard());

    await vi.waitFor(() => {
      expect(result.current.error).toBe('Something went wrong');
    });

    act(() => {
      result.current.clearError();
    });

    expect(result.current.error).toBe(null);
  });
});

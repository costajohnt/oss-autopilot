import { useState, useEffect, useCallback } from 'preact/hooks';
import type { DashboardData, ActionRequest } from '../types';

async function fetchJson(url: string, init?: RequestInit): Promise<DashboardData> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (url: string, init?: RequestInit) => {
    try {
      setLoading(true);
      setData(await fetchJson(url, init));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchData = useCallback(() => load('/api/data'), [load]);
  const refresh = useCallback(() => load('/api/refresh', { method: 'POST' }), [load]);

  const silentRefresh = useCallback(async () => {
    try {
      setRefreshing(true);
      const freshData = await fetchJson('/api/refresh', { method: 'POST' });
      setData(freshData);
      setError(null);
    } catch (e) {
      console.warn('Auto-refresh failed:', e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  const performAction = useCallback(async (action: ActionRequest) => {
    try {
      const updated = await fetchJson('/api/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action),
      });
      setData(updated);
      setError(null);
    } catch (e) {
      // Action may have succeeded server-side; re-fetch to stay in sync
      try {
        setData(await fetchJson('/api/data'));
      } catch (refetchErr) {
        console.error('Failed to re-fetch dashboard data after action error:', refetchErr);
      }
      throw e;
    }
  }, []);

  useEffect(() => {
    fetchData();
    const timer = setTimeout(() => {
      silentRefresh();
    }, 5_000);
    return () => clearTimeout(timer);
  }, [fetchData, silentRefresh]);

  const clearError = useCallback(() => setError(null), []);

  return { data, loading, refreshing, error, clearError, refresh, performAction };
}

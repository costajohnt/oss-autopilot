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

  const performAction = useCallback(async (action: ActionRequest) => {
    const updated = await fetchJson('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action),
    });
    setData(updated);
    setError(null);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  return { data, loading, error, refresh, performAction };
}

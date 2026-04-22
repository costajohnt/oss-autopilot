import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { DashboardData, ActionRequest } from '../types';

// Module-scoped CSRF token cache — the server returns X-CSRF-Token on every
// /api/data response, and state-mutating POST endpoints require it. Using a
// ref rather than useState so updates do not trigger re-renders; the token
// does not need to flow through the component tree.

interface JsonResult {
  data: DashboardData;
  csrfToken: string | null;
}

/** Sentinel thrown from fetchJsonWithToken on a CSRF-related 403 so callers
 * can distinguish it from other errors and retry with a freshly-primed token. */
const CSRF_REJECTED = Symbol('csrf-rejected');
class CsrfRejectedError extends Error {
  readonly kind = CSRF_REJECTED;
  constructor(message: string) {
    super(message);
  }
}

async function fetchJsonWithToken(url: string, init?: RequestInit): Promise<JsonResult> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const message = body?.error || `HTTP ${res.status}`;
    // 403 with a CSRF-token-mentioning body is recoverable — the caller can
    // re-fetch /api/data to pick up the current token and retry once.
    if (res.status === 403 && typeof message === 'string' && /csrf token/i.test(message)) {
      throw new CsrfRejectedError(message);
    }
    throw new Error(message);
  }
  const csrfToken = res.headers.get('X-CSRF-Token');
  const data = (await res.json()) as DashboardData;
  return { data, csrfToken };
}

export function useDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const csrfTokenRef = useRef<string | null>(null);

  const applyResult = useCallback((result: JsonResult) => {
    if (result.csrfToken) csrfTokenRef.current = result.csrfToken;
    setData(result.data);
  }, []);

  const buildPostInit = useCallback((body?: string): RequestInit => {
    const init: RequestInit = { method: 'POST' };
    const headers: Record<string, string> = {};
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = body;
    }
    if (csrfTokenRef.current) headers['X-CSRF-Token'] = csrfTokenRef.current;
    if (Object.keys(headers).length > 0) init.headers = headers;
    return init;
  }, []);

  const postWithCsrf = useCallback(
    async (url: string, body?: string): Promise<JsonResult> => {
      try {
        return await fetchJsonWithToken(url, buildPostInit(body));
      } catch (err) {
        if (!(err instanceof CsrfRejectedError)) throw err;
        // Stale-tab recovery: the server rotated tokens (e.g. after upgrade)
        // or the client never captured one. Re-prime via /api/data, then
        // retry the POST exactly once. If the retry also fails we surface
        // the original server message so the user sees "please refresh".
        try {
          const primed = await fetchJsonWithToken('/api/data');
          if (primed.csrfToken) csrfTokenRef.current = primed.csrfToken;
        } catch {
          throw err;
        }
        return fetchJsonWithToken(url, buildPostInit(body));
      }
    },
    [buildPostInit],
  );

  const load = useCallback(
    async (fetcher: () => Promise<JsonResult>) => {
      try {
        setLoading(true);
        applyResult(await fetcher());
        setLastUpdated(Date.now());
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [applyResult],
  );

  const fetchData = useCallback(() => load(() => fetchJsonWithToken('/api/data')), [load]);
  const refresh = useCallback(() => load(() => postWithCsrf('/api/refresh')), [load, postWithCsrf]);

  const silentRefresh = useCallback(async () => {
    try {
      setRefreshing(true);
      applyResult(await postWithCsrf('/api/refresh'));
      setLastUpdated(Date.now());
      setError(null);
    } catch (e) {
      console.warn('Auto-refresh failed:', e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, [applyResult, postWithCsrf]);

  const performAction = useCallback(
    async (action: ActionRequest) => {
      try {
        const result = await postWithCsrf('/api/action', JSON.stringify(action));
        applyResult(result);
        setError(null);
      } catch (e) {
        // Action may have succeeded server-side; re-fetch to stay in sync
        try {
          applyResult(await fetchJsonWithToken('/api/data'));
        } catch (refetchErr) {
          console.error('Failed to re-fetch dashboard data after action error:', refetchErr);
        }
        throw e;
      }
    },
    [applyResult, postWithCsrf],
  );

  useEffect(() => {
    fetchData();
    const timer = setTimeout(silentRefresh, 5_000);
    return () => clearTimeout(timer);
  }, [fetchData, silentRefresh]);

  const clearError = useCallback(() => setError(null), []);

  return { data, loading, refreshing, error, clearError, refresh, performAction, lastUpdated };
}

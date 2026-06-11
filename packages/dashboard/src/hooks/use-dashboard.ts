import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
// Use the dedicated subpath export so Vite only bundles the pure zod schema,
// not the core barrel (which eagerly loads state/pr-monitor/etc. — Node-only
// modules that throw `process is not defined` in the browser bundle).
import { validateDashboardData } from '@oss-autopilot/core/dashboard-schema';
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

/** Sentinel thrown from fetchJsonWithToken on a 409 concurrency conflict
 * (#1397) — the server lost an optimistic compare-and-swap on state.json to
 * an external writer. Retryable: re-prime via /api/data and retry once. */
const CONFLICT = Symbol('conflict');
class ConflictError extends Error {
  readonly kind = CONFLICT;
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
    // 409 means a concurrent state write — the server already retried once
    // (#1397). Recoverable the same way as a stale CSRF token: re-fetch
    // /api/data for a fresh baseline and retry the POST once.
    if (res.status === 409) {
      throw new ConflictError(typeof message === 'string' ? message : `HTTP ${res.status}`);
    }
    throw new Error(message);
  }
  const csrfToken = res.headers.get('X-CSRF-Token');
  const rawJson = await res.json();

  // Runtime schema validation (#1050). TypeScript can't reach across the
  // process boundary to the CLI server — if the server drops or renames a
  // field, the dashboard would previously hit `Cannot read property X of
  // undefined` at some random render site. Validate here so drift surfaces
  // as a clean error message instead of a render crash.
  const validation = validateDashboardData(rawJson);
  if (!validation.ok) {
    console.error('[dashboard] /api/data schema validation failed:', validation.message, rawJson);
    throw new Error(validation.message);
  }
  return { data: validation.data as unknown as DashboardData, csrfToken };
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
        if (!(err instanceof CsrfRejectedError) && !(err instanceof ConflictError)) throw err;
        // Recoverable rejections, both retried the same way:
        // - CsrfRejectedError: stale-tab recovery — the server rotated tokens
        //   (e.g. after upgrade) or the client never captured one.
        // - ConflictError (409, #1397): a concurrent state write beat us;
        //   re-priming picks up the fresh state baseline.
        // Re-prime via /api/data, then retry the POST exactly once. If the
        // retry also fails we surface the server's message via the normal
        // error path (a second 409 propagates from fetchJsonWithToken).
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
    void fetchData();
    const timer = setTimeout(() => {
      void silentRefresh();
    }, 5000);
    return () => clearTimeout(timer);
  }, [fetchData, silentRefresh]);

  const clearError = useCallback(() => setError(null), []);

  return { data, loading, refreshing, error, clearError, refresh, performAction, lastUpdated };
}

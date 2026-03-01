import { useState, useEffect } from 'preact/hooks';
import type { DashboardData } from './types';

type LoadingState = 'loading' | 'ready' | 'error';

export function App() {
  const [state, setState] = useState<LoadingState>('loading');
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/data')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        return res.json();
      })
      .then((json: DashboardData) => {
        setData(json);
        setState('ready');
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setState('error');
      });
  }, []);

  if (state === 'loading') {
    return (
      <div class="shell-center">
        <p class="shell-status">Loading dashboard data...</p>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div class="shell-center">
        <p class="shell-status shell-error">Failed to load dashboard data</p>
        <p class="shell-detail">{error}</p>
        <button class="shell-retry" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <h1>OSS Autopilot</h1>
        {data && (
          <span class="dashboard-subtitle">
            {data.stats.activePRs} active PRs &middot; {data.stats.mergedPRs} merged &middot; {data.stats.mergeRate}{' '}
            merge rate
          </span>
        )}
      </header>
      <main class="dashboard-main">
        <p class="shell-status">Dashboard components loading...</p>
      </main>
    </div>
  );
}

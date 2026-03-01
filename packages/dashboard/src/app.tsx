import { useDashboard } from './hooks/use-dashboard';

export function App() {
  const { data, loading, error, refresh } = useDashboard();

  if (loading && !data) {
    return (
      <div class="shell-center">
        <p class="shell-status">Loading dashboard data...</p>
      </div>
    );
  }

  if (error && !data) {
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

  if (!data) return null;

  return (
    <div class="dashboard">
      <header class="dashboard-header">
        <h1>OSS Autopilot</h1>
        <span class="dashboard-subtitle">
          {data.stats.activePRs} active PRs &middot; {data.stats.mergedPRs} merged &middot;{' '}
          {data.stats.mergeRate} merge rate
        </span>
        <button class="refresh-btn" onClick={refresh} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </header>
      <main class="dashboard-main">
        <p class="shell-status">Dashboard components loading...</p>
      </main>
    </div>
  );
}

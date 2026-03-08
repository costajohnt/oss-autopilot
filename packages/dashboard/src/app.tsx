import { useState, useMemo } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { useDashboard } from './hooks/use-dashboard';
import { StatsBar } from './components/stats-bar';
import { FilterBar, type Filters } from './components/filter-bar';
import { PRList } from './components/pr-list';
import { PRDetail } from './components/pr-detail';
import { ChartPanel } from './components/chart-panel';
import { IssueList } from './components/issue-list';
import { RecentActivity } from './components/recent-activity';
import { MergedPRList } from './components/merged-pr-list';
import { ClosedPRList } from './components/closed-pr-list';
import type { DashboardStats } from './types';

interface DashboardHeaderProps {
  stats: DashboardStats;
  loading: boolean;
  refreshing: boolean;
  onRefresh: () => void;
}

function DashboardHeader({ stats, loading, refreshing, onRefresh }: DashboardHeaderProps) {
  return (
    <header class="dashboard-header">
      <h1>OSS Autopilot</h1>
      <span class="dashboard-subtitle">
        {stats.activePRs} active PRs &middot; {stats.mergedPRs} merged &middot; {stats.mergeRate} merge rate
      </span>
      <button class="refresh-btn" onClick={onRefresh} disabled={loading || refreshing}>
        {loading ? 'Refreshing...' : refreshing ? 'Updating...' : 'Refresh'}
      </button>
    </header>
  );
}

function AppContent() {
  const { data, loading, refreshing, error, clearError, refresh, performAction } = useDashboard();
  const [filters, setFilters] = useState<Filters>({ status: 'all', repo: 'all', search: '' });
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const { path, route } = useLocation();

  const shelvedUrls = useMemo(() => new Set(data?.shelvedPRUrls ?? []), [data?.shelvedPRUrls]);

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

  // Route: /merged — show all merged PRs
  if (path === '/merged') {
    const mergedPRs = data.allMergedPRs ?? [];
    return (
      <div class="dashboard">
        <DashboardHeader stats={data.stats} loading={loading} refreshing={refreshing} onRefresh={refresh} />
        <MergedPRList mergedPRs={mergedPRs} onBack={() => route('/')} />
      </div>
    );
  }

  // Route: /closed — show all closed PRs
  if (path === '/closed') {
    const closedPRs = data.allClosedPRs ?? [];
    return (
      <div class="dashboard">
        <DashboardHeader stats={data.stats} loading={loading} refreshing={refreshing} onRefresh={refresh} />
        <ClosedPRList closedPRs={closedPRs} onBack={() => route('/')} />
      </div>
    );
  }

  // Default route: dashboard home
  const repos = [...new Set(data.activePRs.map((pr) => pr.repo))].sort();
  const statuses = [...new Set(data.activePRs.map((pr) => pr.status))].sort();

  const filteredPRs = data.activePRs.filter((pr) => {
    if (filters.status !== 'all' && pr.status !== filters.status) return false;
    if (filters.repo !== 'all' && pr.repo !== filters.repo) return false;
    if (filters.search) {
      const term = filters.search.toLowerCase();
      if (!pr.title.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  const selectedPR = selectedUrl ? (data.activePRs.find((pr) => pr.url === selectedUrl) ?? null) : null;

  return (
    <div class="dashboard">
      <DashboardHeader stats={data.stats} loading={loading} refreshing={refreshing} onRefresh={refresh} />

      {error && (
        <div class="error-banner">
          <span>{error}</span>
          <button class="error-banner-dismiss" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      <main class="dashboard-main">
        <StatsBar stats={data.stats} onMergedClick={() => route('/merged')} onClosedClick={() => route('/closed')} />
        <FilterBar filters={filters} onFilterChange={setFilters} repos={repos} statuses={statuses} />

        <div class="dashboard-content">
          <PRList prs={filteredPRs} selectedUrl={selectedUrl} onSelect={setSelectedUrl} shelvedUrls={shelvedUrls} />
          {selectedPR && (
            <PRDetail
              pr={selectedPR}
              isShelved={shelvedUrls.has(selectedPR.url)}
              onAction={performAction}
              onClose={() => setSelectedUrl(null)}
            />
          )}
        </div>

        <ChartPanel
          monthlyMerged={data.monthlyMerged}
          monthlyOpened={data.monthlyOpened}
          monthlyClosed={data.monthlyClosed}
          topRepos={data.topRepos}
        />

        <RecentActivity
          mergedPRs={data.recentlyMergedPRs ?? []}
          closedPRs={data.recentlyClosedPRs ?? []}
          autoUnshelvedPRs={data.autoUnshelvedPRs ?? []}
        />

        <IssueList issues={data.issueResponses} onAction={performAction} />
      </main>
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <AppContent />
    </LocationProvider>
  );
}

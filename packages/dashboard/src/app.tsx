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
import { SkeletonLoader } from './components/skeleton-loader';
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
      <div class="header-left">
        <h1>OSS Autopilot</h1>
        <div class="header-stats">
          <span>
            <span class="val">{stats.activePRs}</span> active
          </span>
          <span class="header-pipe">|</span>
          <span>
            <span class="val">{stats.mergedPRs}</span> merged
          </span>
          <span class="header-pipe">|</span>
          <span>
            <span class="val">{stats.mergeRate}</span> merge rate
          </span>
        </div>
      </div>
      <div class="header-right">
        <button class="refresh-btn" onClick={onRefresh} disabled={loading || refreshing}>
          {(loading || refreshing) && <span class="spinner" />}
          {loading ? 'Refreshing...' : refreshing ? 'Updating...' : 'Refresh'}
        </button>
      </div>
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
      <div class="skeleton-wrapper">
        <SkeletonLoader />
        <div class="shell-center shell-center--skeleton">
          <p class="shell-status">Loading dashboard data...</p>
        </div>
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
        <MergedPRList mergedPRs={mergedPRs} repoMetadata={data.repoMetadata} onBack={() => route('/')} />
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
      const searchable = `${pr.title} ${pr.repo} ${pr.number}`.toLowerCase();
      if (!searchable.includes(term)) return false;
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
        <div class="animate-in delay-1">
          <StatsBar stats={data.stats} onMergedClick={() => route('/merged')} onClosedClick={() => route('/closed')} />
        </div>
        <div class="animate-in delay-2">
          <FilterBar
            filters={filters}
            onFilterChange={setFilters}
            repos={repos}
            statuses={statuses}
            totalCount={data.activePRs.length}
            filteredCount={filteredPRs.length}
          />
        </div>

        <div class="dashboard-content animate-in delay-3">
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

        <div class="animate-in delay-4">
          <ChartPanel
            monthlyMerged={data.monthlyMerged}
            monthlyOpened={data.monthlyOpened}
            monthlyClosed={data.monthlyClosed}
            topRepos={data.topRepos}
          />
        </div>

        <div class="animate-in delay-5">
          <RecentActivity
            mergedPRs={data.recentlyMergedPRs ?? []}
            closedPRs={data.recentlyClosedPRs ?? []}
            autoUnshelvedPRs={data.autoUnshelvedPRs ?? []}
          />
        </div>

        <div class="animate-in delay-6">
          <IssueList issues={data.issueResponses} onAction={performAction} />
        </div>
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

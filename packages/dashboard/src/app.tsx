import { useState, useMemo } from 'preact/hooks';
import { useDashboard } from './hooks/use-dashboard';
import { StatsBar } from './components/stats-bar';
import { FilterBar, type Filters } from './components/filter-bar';
import { PRList } from './components/pr-list';
import { PRDetail } from './components/pr-detail';
import { ChartPanel } from './components/chart-panel';
import { IssueList } from './components/issue-list';

export function App() {
  const { data, loading, error, refresh, performAction } = useDashboard();
  const [filters, setFilters] = useState<Filters>({ status: 'all', repo: 'all', search: '' });
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

  const shelvedUrls = useMemo(
    () => new Set(data?.shelvedPRUrls ?? []),
    [data?.shelvedPRUrls],
  );

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

  const selectedPR = selectedUrl
    ? data.activePRs.find((pr) => pr.url === selectedUrl) ?? null
    : null;

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
        <StatsBar stats={data.stats} />
        <FilterBar
          filters={filters}
          onFilterChange={setFilters}
          repos={repos}
          statuses={statuses}
        />

        <div class="dashboard-content">
          <PRList
            prs={filteredPRs}
            selectedUrl={selectedUrl}
            onSelect={setSelectedUrl}
            shelvedUrls={shelvedUrls}
          />
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
          topRepos={data.topRepos}
        />

        <IssueList issues={data.issueResponses} />
      </main>
    </div>
  );
}

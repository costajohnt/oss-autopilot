import { useState, useMemo, useEffect, useRef } from 'preact/hooks';
import { LocationProvider, useLocation } from 'preact-iso';
import { useDashboard } from './hooks/use-dashboard';
import { useTheme, type Theme } from './hooks/use-theme';
import { useCelebration } from './hooks/use-celebration';
import { StatsBar } from './components/stats-bar';
import { FilterBar, type Filters } from './components/filter-bar';
import { PRList } from './components/pr-list';
import { PRDetail } from './components/pr-detail';
import { LazyChartPanel } from './components/chart-panel-lazy';
import { IssueList } from './components/issue-list';
import { RecentActivity } from './components/recent-activity';
import { MergedPRList } from './components/merged-pr-list';
import { ClosedPRList } from './components/closed-pr-list';
import { VettedIssueList } from './components/vetted-issue-list';
import { SkeletonLoader } from './components/skeleton-loader';
import { ThemeToggle } from './components/theme-toggle';
import { CelebrationToast } from './components/celebration-toast';
import { formatRelativeTime, refreshLabel } from './utils';
import type { DashboardStats } from './types';

interface DashboardHeaderProps {
  stats: DashboardStats;
  loading: boolean;
  refreshing: boolean;
  lastUpdated: number | null;
  onRefresh: () => void;
  theme: Theme;
  onToggleTheme: () => void;
  onCelebrate: () => void;
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M14 8A6 6 0 1 1 8 2" />
      <path d="M8 2L11 2L11 5" />
    </svg>
  );
}

function DashboardHeader({
  stats,
  loading,
  refreshing,
  lastUpdated,
  onRefresh,
  theme,
  onToggleTheme,
  onCelebrate,
}: DashboardHeaderProps) {
  return (
    <header class="dashboard-header">
      <div class="header-brand">
        <img class="header-icon" src="/favicon.svg" alt="" width="72" height="72" />
        <h1>OSS Autopilot</h1>
      </div>
      <div class="header-bar">
        <div class="header-stats">
          <span>
            <span class="val" style={{ color: 'var(--green)' }}>
              {stats.activePRs}
            </span>{' '}
            active
          </span>
          <span class="header-sep" />
          <span>
            <span class="val" style={{ color: 'var(--purple)' }}>
              {stats.mergedPRs}
            </span>{' '}
            merged
          </span>
          <span class="header-sep" />
          <span>
            <span class="val" style={{ color: 'var(--amber)' }}>
              {stats.mergeRate}
            </span>{' '}
            merge rate
          </span>
        </div>
        <div class="header-right">
          {lastUpdated && <span class="last-updated">{formatRelativeTime(lastUpdated)}</span>}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          <button type="button" class="celebrate-btn" onClick={onCelebrate} aria-label="Celebrate">
            🎉
          </button>
          <button class="refresh-btn" onClick={onRefresh} disabled={loading || refreshing}>
            {loading || refreshing ? <span class="spinner" /> : <RefreshIcon />}
            {refreshLabel(loading, refreshing)}
          </button>
        </div>
      </div>
    </header>
  );
}

// Explicit route table (#1052). Any path outside this set renders a 404 view
// rather than silently falling through to the dashboard home.
const KNOWN_ROUTES = new Set(['/', '/merged', '/closed', '/issues']);

function AppContent() {
  const { data, loading, refreshing, error, clearError, refresh, performAction, lastUpdated } = useDashboard();
  const { theme, toggleTheme } = useTheme();
  const {
    celebration,
    dismiss: dismissCelebration,
    trigger: triggerCelebration,
  } = useCelebration(data?.stats.mergedPRs);
  const [filters, setFilters] = useState<Filters>({ status: 'all', repo: 'all', search: '' });
  const [selectedUrl, setSelectedUrl] = useState<string | null>(null);
  const [shelvedOpen, setShelvedOpen] = useState(false);
  const { path, route } = useLocation();
  const routeHeadingRef = useRef<HTMLHeadingElement | null>(null);

  // Route-change focus management (#1052). When the path changes, move
  // keyboard focus to the active view's primary heading so screen readers
  // announce the new view. Using tabIndex=-1 on the h2 lets programmatic
  // focus succeed without placing the heading in the normal tab order.
  useEffect(() => {
    routeHeadingRef.current?.focus({ preventScroll: false });
  }, [path]);

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
      <div class="shell-center" role="alert">
        <p class="shell-status shell-error">Failed to load dashboard data</p>
        <p class="shell-detail">{error}</p>
        <button class="shell-retry" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }

  if (!data) return null;

  const headerProps: DashboardHeaderProps = {
    stats: data.stats,
    loading,
    refreshing,
    lastUpdated,
    onRefresh: refresh,
    theme,
    onToggleTheme: toggleTheme,
    onCelebrate: triggerCelebration,
  };

  // Shared partial-data banner — rendered on every route so users don't
  // lose the "showing partial data" signal when navigating to /merged
  // etc., where the affected arrays (allMergedPRs, allClosedPRs) are the
  // primary content. See #1035.
  const partialBanner =
    data.partialFailures && data.partialFailures.length > 0 ? (
      <div class="partial-banner" role="status" aria-live="polite">
        <span>
          Showing partial data — {data.partialFailures.length} background fetch
          {data.partialFailures.length === 1 ? '' : 'es'} failed ({data.partialFailures.join(', ')}). Some sections may
          be incomplete; try refreshing.
        </span>
      </div>
    ) : null;

  // Route: /merged — show all merged PRs
  if (path === '/merged') {
    const mergedPRs = data.allMergedPRs ?? [];
    return (
      <div class="dashboard">
        <DashboardHeader {...headerProps} />
        {partialBanner}
        <main id="main-content" class="dashboard-main">
          <h2 ref={routeHeadingRef} tabIndex={-1} class="visually-hidden">
            Merged pull requests
          </h2>
          <MergedPRList mergedPRs={mergedPRs} repoMetadata={data.repoMetadata} onBack={() => route('/')} />
        </main>
        <CelebrationToast celebration={celebration} onDismiss={dismissCelebration} />
      </div>
    );
  }

  // Route: /closed — show all closed PRs
  if (path === '/closed') {
    const closedPRs = data.allClosedPRs ?? [];
    return (
      <div class="dashboard">
        <DashboardHeader {...headerProps} />
        {partialBanner}
        <main id="main-content" class="dashboard-main">
          <h2 ref={routeHeadingRef} tabIndex={-1} class="visually-hidden">
            Closed pull requests
          </h2>
          <ClosedPRList closedPRs={closedPRs} onBack={() => route('/')} />
        </main>
        <CelebrationToast celebration={celebration} onDismiss={dismissCelebration} />
      </div>
    );
  }

  // Route: /issues — show vetted issue list
  if (path === '/issues') {
    return (
      <div class="dashboard">
        <DashboardHeader {...headerProps} />
        {partialBanner}
        <main id="main-content" class="dashboard-main">
          <h2 ref={routeHeadingRef} tabIndex={-1} class="visually-hidden">
            Vetted issues
          </h2>
          {data.vettedIssues ? (
            <VettedIssueList
              vettedIssues={data.vettedIssues}
              repoMetadata={data.repoMetadata}
              onBack={() => route('/')}
            />
          ) : (
            <div class="merged-view merged-view--full-width">
              <div class="merged-view-header">
                <button class="merged-view-back" onClick={() => route('/')} type="button">
                  &larr; Back
                </button>
                <div>
                  <h2 class="merged-view-title">Vetted Issues</h2>
                </div>
              </div>
              <div class="merged-view-empty">
                No vetted issue list found. Configure one via /setup-oss or create a potential-issue-list.md file.
              </div>
            </div>
          )}
        </main>
        <CelebrationToast celebration={celebration} onDismiss={dismissCelebration} />
      </div>
    );
  }

  // Route: 404 — unknown path (#1052). Explicit view instead of silently
  // falling through to the dashboard home.
  if (!KNOWN_ROUTES.has(path)) {
    return (
      <div class="dashboard">
        <DashboardHeader {...headerProps} />
        {partialBanner}
        <main id="main-content" class="dashboard-main" role="alert">
          <div class="merged-view merged-view--full-width">
            <div class="merged-view-header">
              <button class="merged-view-back" onClick={() => route('/')} type="button">
                &larr; Back to dashboard
              </button>
              <div>
                <h2 ref={routeHeadingRef} tabIndex={-1} class="merged-view-title">
                  Page not found
                </h2>
              </div>
            </div>
            <div class="merged-view-empty">
              <p>
                The path <code>{path}</code> doesn&apos;t match any known route. Try the dashboard home, or one of the
                stat pills to navigate to merged / closed / issue views.
              </p>
            </div>
          </div>
        </main>
        <CelebrationToast celebration={celebration} onDismiss={dismissCelebration} />
      </div>
    );
  }

  // Default route: dashboard home.
  //
  // These derivations were previously recomputed on every render — including
  // every keystroke in the search input — even though they only depend on
  // the stable PR list. Memoize so `filter` over hundreds of PRs doesn't
  // rerun on unrelated state changes (#1058 M37).
  const repos = useMemo(() => [...new Set(data.activePRs.map((pr) => pr.repo))].sort(), [data.activePRs]);
  const statuses = useMemo(() => [...new Set(data.activePRs.map((pr) => pr.status))].sort(), [data.activePRs]);

  const filteredPRs = useMemo(() => {
    return data.activePRs.filter((pr) => {
      if (filters.status !== 'all' && pr.status !== filters.status) return false;
      if (filters.repo !== 'all' && pr.repo !== filters.repo) return false;
      if (filters.search) {
        const term = filters.search.toLowerCase();
        const searchable = `${pr.title} ${pr.repo} ${pr.number}`.toLowerCase();
        if (!searchable.includes(term)) return false;
      }
      return true;
    });
  }, [data.activePRs, filters.status, filters.repo, filters.search]);

  const selectedPR = selectedUrl ? (data.activePRs.find((pr) => pr.url === selectedUrl) ?? null) : null;

  const activePRs = useMemo(
    () => data.activePRs.filter((pr) => !shelvedUrls.has(pr.url)),
    [data.activePRs, shelvedUrls],
  );
  const needAttentionCount = activePRs.filter((pr) => pr.status === 'needs_addressing').length;
  const waitingCount = activePRs.filter((pr) => pr.status === 'waiting_on_maintainer').length;

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div class="dashboard">
      <DashboardHeader {...headerProps} />

      {error && (
        <div class="error-banner" role="alert">
          <span>{error}</span>
          <button class="error-banner-dismiss" onClick={clearError}>
            Dismiss
          </button>
        </div>
      )}

      {partialBanner}

      <main id="main-content" class="dashboard-main">
        <h2 ref={routeHeadingRef} tabIndex={-1} class="visually-hidden">
          Dashboard
        </h2>
        <div class="animate-in delay-1">
          <StatsBar
            stats={data.stats}
            needAttentionCount={needAttentionCount}
            waitingCount={waitingCount}
            onNeedAttentionClick={() => scrollTo('section-action')}
            onWaitingClick={() => scrollTo('section-waiting')}
            onShelvedClick={() => {
              setShelvedOpen(true);
              // Delay scroll slightly so the section renders before scrolling
              setTimeout(() => scrollTo('section-shelved'), 50);
            }}
            onMergedClick={() => route('/merged')}
            onClosedClick={() => route('/closed')}
            onIssuesClick={() => route('/issues')}
          />
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
          <PRList
            prs={filteredPRs}
            selectedUrl={selectedUrl}
            onSelect={setSelectedUrl}
            shelvedUrls={shelvedUrls}
            shelvedOpen={shelvedOpen}
            onShelvedToggle={() => setShelvedOpen(!shelvedOpen)}
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

        <div class="animate-in delay-4">
          <LazyChartPanel
            monthlyMerged={data.monthlyMerged}
            monthlyOpened={data.monthlyOpened}
            monthlyClosed={data.monthlyClosed}
            topRepos={data.topRepos}
            theme={theme}
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
      <CelebrationToast celebration={celebration} onDismiss={dismissCelebration} />
    </div>
  );
}

export function App() {
  return (
    <LocationProvider>
      <a class="skip-link" href="#main-content">
        Skip to main content
      </a>
      <AppContent />
    </LocationProvider>
  );
}

/**
 * Client-side JavaScript for the dashboard: theme toggle, filtering, Chart.js charts.
 */

import type { DailyDigest, AgentState } from '../core/types.js';
import type { DashboardStats } from './dashboard-data.js';

/** Static client-side JS: theme toggle + filter/search logic. */
const THEME_AND_FILTER_SCRIPT = `
    // === Theme Toggle ===
    (function() {
      var html = document.documentElement;
      var toggle = document.getElementById('themeToggle');
      var sunIcon = document.getElementById('themeIconSun');
      var moonIcon = document.getElementById('themeIconMoon');
      var label = document.getElementById('themeLabel');

      function getEffectiveTheme() {
        try {
          var stored = localStorage.getItem('oss-dashboard-theme');
          if (stored === 'light' || stored === 'dark') return stored;
        } catch (e) { /* localStorage unavailable (private browsing) */ }
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
      }

      function applyTheme(theme) {
        html.setAttribute('data-theme', theme);
        if (theme === 'light') {
          sunIcon.style.display = 'none';
          moonIcon.style.display = 'block';
          label.textContent = 'Dark';
        } else {
          sunIcon.style.display = 'block';
          moonIcon.style.display = 'none';
          label.textContent = 'Light';
        }
      }

      applyTheme(getEffectiveTheme());

      toggle.addEventListener('click', function() {
        var current = html.getAttribute('data-theme');
        var next = current === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem('oss-dashboard-theme', next); } catch (e) { /* private browsing */ }
        applyTheme(next);
      });
    })();

    // === Filtering & Search ===
    (function() {
      var searchInput = document.getElementById('searchInput');
      var statusFilter = document.getElementById('statusFilter');
      var repoFilter = document.getElementById('repoFilter');
      var filterCount = document.getElementById('filterCount');

      function applyFilters() {
        var query = searchInput.value.toLowerCase().trim();
        var status = statusFilter.value;
        var repo = repoFilter.value;
        var allItems = document.querySelectorAll('.health-item[data-status], .pr-item[data-status]');
        var visible = 0;
        var total = allItems.length;

        allItems.forEach(function(item) {
          var itemStatus = item.getAttribute('data-status') || '';
          var itemRepo = item.getAttribute('data-repo') || '';
          var itemTitle = item.getAttribute('data-title') || '';

          var matchesStatus = (status === 'all') || (itemStatus === status);
          var matchesRepo = (repo === 'all') || (itemRepo === repo);
          var matchesSearch = !query || itemTitle.indexOf(query) !== -1;

          if (matchesStatus && matchesRepo && matchesSearch) {
            item.setAttribute('data-hidden', 'false');
            visible++;
          } else {
            item.setAttribute('data-hidden', 'true');
          }
        });

        // Show/hide parent sections if all children are hidden
        var sections = document.querySelectorAll('.health-section, .pr-list-section');
        sections.forEach(function(section) {
          var items = section.querySelectorAll('.health-item[data-status], .pr-item[data-status]');
          if (items.length === 0) return; // sections without filterable items (e.g. empty state)
          var anyVisible = false;
          items.forEach(function(item) {
            if (item.getAttribute('data-hidden') !== 'true') anyVisible = true;
          });
          section.style.display = anyVisible ? '' : 'none';
        });

        var isFiltering = (status !== 'all' || repo !== 'all' || query.length > 0);
        filterCount.textContent = isFiltering ? (visible + ' of ' + total + ' items') : '';
      }

      searchInput.addEventListener('input', applyFilters);
      statusFilter.addEventListener('change', applyFilters);
      repoFilter.addEventListener('change', applyFilters);
    })();
`;

/** Generate the Chart.js JavaScript for the dashboard. */
export function generateDashboardScripts(
  stats: DashboardStats,
  monthlyMerged: Record<string, number>,
  monthlyClosed: Record<string, number>,
  monthlyOpened: Record<string, number>,
  digest: DailyDigest,
  state: Readonly<AgentState>,
): string {
  // === Status Doughnut ===
  const statusChart = `
    Chart.defaults.color = '#6e7681';
    Chart.defaults.borderColor = 'rgba(48, 54, 61, 0.4)';
    Chart.defaults.font.family = "'Geist', sans-serif";
    Chart.defaults.font.size = 11;

    // === Status Doughnut ===
    new Chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: {
        labels: ['Active', 'Shelved', 'Merged', 'Closed'],
        datasets: [{
          data: [${stats.activePRs}, ${stats.shelvedPRs}, ${stats.mergedPRs}, ${stats.closedPRs}],
          backgroundColor: ['#3fb950', '#6e7681', '#a855f7', '#484f58'],
          borderColor: 'rgba(8, 11, 16, 0.8)',
          borderWidth: 2,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { padding: 16, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } }
          }
        }
      }
    });`;

  // === Repository Breakdown ===
  const repoChart = (() => {
    // Filter helper: exclude repos matching excludeRepos/excludeOrgs or below minStars (#216)
    const { excludeRepos: exRepos = [], excludeOrgs: exOrgs, minStars } = state.config;
    const starThreshold = minStars ?? 50;
    const shouldExcludeRepo = (repo: string): boolean => {
      const repoLower = repo.toLowerCase();
      if (exRepos.some((r) => r.toLowerCase() === repoLower)) return true;
      if (exOrgs?.some((o) => o.toLowerCase() === repoLower.split('/')[0])) return true;
      const score = (state.repoScores || {})[repo];
      // Fail-open: repos without cached star data are shown (not excluded).
      // Unlike issue-discovery (fail-closed), the dashboard shows the user's own
      // contribution history — hiding repos just because a star fetch failed would be confusing.
      if (score?.stargazersCount !== undefined && score.stargazersCount < starThreshold) return true;
      return false;
    };

    // Sort repos by total PRs (merged + active + closed) and build "Other" bucket
    const allRepoEntries = Object.entries(
      // Rebuild from full prsByRepo to get all repos, not just top 10
      (() => {
        const all: Record<string, { active: number; merged: number; closed: number }> = {};
        for (const pr of digest.openPRs || []) {
          if (shouldExcludeRepo(pr.repo)) continue;
          if (!all[pr.repo]) all[pr.repo] = { active: 0, merged: 0, closed: 0 };
          all[pr.repo].active++;
        }
        for (const [repo, score] of Object.entries(state.repoScores || {})) {
          if (shouldExcludeRepo(repo)) continue;
          if (!all[repo]) all[repo] = { active: 0, merged: 0, closed: 0 };
          all[repo].merged = score.mergedPRCount;
          all[repo].closed = score.closedWithoutMergeCount;
        }
        return all;
      })(),
    ).sort((a, b) => {
      const totalA = a[1].merged + a[1].active + a[1].closed;
      const totalB = b[1].merged + b[1].active + b[1].closed;
      return totalB - totalA;
    });

    const displayRepos = allRepoEntries.slice(0, 10);
    const otherRepos = allRepoEntries.slice(10);
    const grandTotal = allRepoEntries.reduce((sum, [, d]) => sum + d.merged + d.active + d.closed, 0);

    if (otherRepos.length > 0) {
      const otherData = otherRepos.reduce(
        (acc, [, d]) => ({
          active: acc.active + d.active,
          merged: acc.merged + d.merged,
          closed: acc.closed + d.closed,
        }),
        { active: 0, merged: 0, closed: 0 },
      );
      displayRepos.push(['Other', otherData]);
    }

    const repoLabels = displayRepos.map(([repo]) => (repo === 'Other' ? 'Other' : repo.split('/')[1] || repo));
    const mergedData = displayRepos.map(([, d]) => d.merged);
    const activeData = displayRepos.map(([, d]) => d.active);
    const closedData = displayRepos.map(([, d]) => d.closed);

    return `
    new Chart(document.getElementById('reposChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(repoLabels)},
        datasets: [
          { label: 'Merged', data: ${JSON.stringify(mergedData)}, backgroundColor: '#a855f7', borderRadius: 3 },
          { label: 'Active', data: ${JSON.stringify(activeData)}, backgroundColor: '#3fb950', borderRadius: 3 },
          { label: 'Closed', data: ${JSON.stringify(closedData)}, backgroundColor: '#484f58', borderRadius: 3 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 } } },
          y: { stacked: true, grid: { color: 'rgba(48, 54, 61, 0.3)' }, ticks: { stepSize: 1 } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } },
          tooltip: {
            callbacks: {
              afterBody: function(context) {
                const idx = context[0].dataIndex;
                const total = ${JSON.stringify(mergedData)}[idx] + ${JSON.stringify(activeData)}[idx] + ${JSON.stringify(closedData)}[idx];
                const pct = ${grandTotal} > 0 ? ((total / ${grandTotal}) * 100).toFixed(1) : '0.0';
                return pct + '% of all PRs';
              }
            }
          }
        }
      }
    });`;
  })();

  // === Contribution Timeline ===
  const timelineChart = (() => {
    // Generate a contiguous range of the last 6 months from today
    // This avoids gaps when historical data spans years (e.g. 2019 and 2026)
    const now = new Date();
    const allMonths: string[] = [];
    for (let offset = 5; offset >= 0; offset--) {
      const d = new Date(now.getFullYear(), now.getMonth() - offset, 1);
      allMonths.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    return `
    const timelineMonths = ${JSON.stringify(allMonths)};
    const openedData = ${JSON.stringify(monthlyOpened)};
    const mergedData = ${JSON.stringify(monthlyMerged)};
    const closedData = ${JSON.stringify(monthlyClosed)};
    new Chart(document.getElementById('monthlyChart'), {
      type: 'bar',
      data: {
        labels: timelineMonths,
        datasets: [
          {
            label: 'Opened',
            data: timelineMonths.map(m => openedData[m] || 0),
            backgroundColor: '#58a6ff',
            borderRadius: 3
          },
          {
            label: 'Merged',
            data: timelineMonths.map(m => mergedData[m] || 0),
            backgroundColor: '#a855f7',
            borderRadius: 3
          },
          {
            label: 'Closed',
            data: timelineMonths.map(m => closedData[m] || 0),
            backgroundColor: '#484f58',
            borderRadius: 3
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: 'rgba(48, 54, 61, 0.3)' }, beginAtZero: true, ticks: { stepSize: 1 } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { padding: 16, usePointStyle: true, pointStyle: 'circle', font: { size: 11 } } }
        },
        interaction: { intersect: false, mode: 'index' }
      }
    });`;
  })();

  return THEME_AND_FILTER_SCRIPT + statusChart + '\n' + repoChart + '\n' + timelineChart;
}

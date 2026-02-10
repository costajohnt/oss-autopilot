/**
 * Dashboard command
 * Generates HTML stats dashboard from latest digest
 * v2: Fetches fresh data from GitHub if token available, otherwise uses cached lastDigest
 */

import * as fs from 'fs';
import { execFile } from 'child_process';
import { getStateManager, getDashboardPath, PRMonitor, getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import type { FetchedPR, DailyDigest, AgentState, RepoScore, ClosedPR } from '../core/types.js';

interface DashboardOptions {
  open?: boolean;
  json?: boolean;
}

export async function runDashboard(options: DashboardOptions): Promise<void> {
  const stateManager = getStateManager();
  const token = getGitHubToken();
  let digest: DailyDigest | undefined;

  // If we have a token, fetch fresh data
  if (token) {
    console.error('Fetching fresh data from GitHub...');
    try {
      const prMonitor = new PRMonitor(token);
      const [{ prs, failures }, recentlyClosedPRs, mergedResult, closedResult] = await Promise.all([
        prMonitor.fetchUserOpenPRs(),
        prMonitor.fetchRecentlyClosedPRs(),
        prMonitor.fetchUserMergedPRCounts(),
        prMonitor.fetchUserClosedPRCounts(),
      ]);

      if (failures.length > 0) {
        console.error(`Warning: ${failures.length} PR fetch(es) failed`);
      }

      // Store monthly chart data (opened/merged/closed) so charts have data
      const { monthlyCounts, monthlyOpenedCounts: openedFromMerged } = mergedResult;
      const { monthlyCounts: monthlyClosedCounts, monthlyOpenedCounts: openedFromClosed } = closedResult;

      try { stateManager.setMonthlyMergedCounts(monthlyCounts); } catch { /* non-critical */ }
      try { stateManager.setMonthlyClosedCounts(monthlyClosedCounts); } catch { /* non-critical */ }
      try {
        const combinedOpenedCounts: Record<string, number> = { ...openedFromMerged };
        for (const [month, count] of Object.entries(openedFromClosed)) {
          combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + count;
        }
        for (const pr of prs) {
          if (pr.createdAt) {
            const month = pr.createdAt.slice(0, 7);
            combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + 1;
          }
        }
        stateManager.setMonthlyOpenedCounts(combinedOpenedCounts);
      } catch { /* non-critical */ }

      digest = prMonitor.generateDigest(prs, recentlyClosedPRs);
      stateManager.setLastDigest(digest);
      stateManager.save();
      console.error(`Refreshed: ${prs.length} PRs fetched`);
    } catch (error) {
      console.error('Failed to fetch fresh data:', error instanceof Error ? error.message : error);
      console.error('Falling back to cached data...');
      digest = stateManager.getState().lastDigest;
    }
  } else {
    // No token - use cached data
    digest = stateManager.getState().lastDigest;
  }

  // Check if we have a digest to display
  if (!digest) {
    if (options.json) {
      outputJson({ error: 'No data available. Run daily check first with GITHUB_TOKEN.' });
    } else {
      console.error('No dashboard data available. Run the daily check first:');
      console.error('  GITHUB_TOKEN=$(gh auth token) npm start -- daily');
    }
    return;
  }

  const state = stateManager.getState();

  // Gather data for charts from digest
  const prsByRepo: Record<string, { active: number; merged: number; closed: number }> = {};

  // Count active PRs by repo from digest
  for (const pr of (digest.openPRs || [])) {
    if (!prsByRepo[pr.repo]) prsByRepo[pr.repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[pr.repo].active++;
  }

  // Add merged/closed counts from repo scores (historical data)
  for (const [repo, score] of Object.entries(state.repoScores || {})) {
    if (!prsByRepo[repo]) prsByRepo[repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[repo].merged = score.mergedPRCount;
    prsByRepo[repo].closed = score.closedWithoutMergeCount;
  }

  // Sort repos by total PRs (merged + active + closed) — matches the HTML chart sort order
  const topRepos = Object.entries(prsByRepo)
    .sort((a, b) => (b[1].merged + b[1].active + b[1].closed) - (a[1].merged + a[1].active + a[1].closed))
    .slice(0, 10);

  // Monthly activity from per-PR merge dates (populated during daily check)
  const monthlyMerged: Record<string, number> = state.monthlyMergedCounts || {};
  const monthlyClosed: Record<string, number> = state.monthlyClosedCounts || {};
  const monthlyOpened: Record<string, number> = state.monthlyOpenedCounts || {};

  // Build stats from digest
  const summary = digest.summary || { totalActivePRs: 0, totalMergedAllTime: 0, mergeRate: 0, totalNeedingAttention: 0 };
  const stats = {
    activePRs: summary.totalActivePRs,
    dormantPRs: (digest.dormantPRs || []).length,
    mergedPRs: summary.totalMergedAllTime,
    closedPRs: Object.values(state.repoScores || {}).reduce((sum, s) => sum + (s.closedWithoutMergeCount || 0), 0),
    mergeRate: `${(summary.mergeRate ?? 0).toFixed(1)}%`,
    needsResponse: (digest.prsNeedingResponse || []).length,
  };

  if (options.json) {
    outputJson({
      stats,
      prsByRepo,
      topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
      monthlyMerged,
      activePRs: digest.openPRs || [],
    });
    return;
  }

  const html = generateDashboardHtml(stats, monthlyMerged, monthlyClosed, monthlyOpened, digest, state);

  // Write to file in ~/.oss-autopilot/
  const dashboardPath = getDashboardPath();
  fs.writeFileSync(dashboardPath, html);

  console.log(`\n📊 Dashboard generated: ${dashboardPath}`);

  if (options.open) {
    // Use platform-specific open command - path is hardcoded, not user input
    const isWindows = process.platform === 'win32';
    const openCmd = process.platform === 'darwin' ? 'open' :
                    isWindows ? 'cmd' : 'xdg-open';
    const args = isWindows ? ['/c', 'start', '', dashboardPath] : [dashboardPath];

    console.log(`Dashboard: ${dashboardPath}`);
    execFile(openCmd, args, (error) => {
      if (error) {
        console.error('Failed to open browser:', error.message);
        console.error(`Open manually: ${dashboardPath}`);
      }
    });
  } else {
    console.log('Run with --open to open in browser');
  }
}

interface DashboardStats {
  activePRs: number;
  dormantPRs: number;
  mergedPRs: number;
  closedPRs: number;
  mergeRate: string;
  needsResponse: number;
}

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * user-controlled content (e.g. PR titles, comment bodies, author names) into HTML.
 * Note: This escapes HTML entity characters only. It does not sanitize URL schemes
 * (e.g., javascript:) — callers placing values in href attributes should validate
 * the URL scheme if the source is untrusted. GitHub API URLs are trusted.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateDashboardHtml(
  stats: DashboardStats,
  monthlyMerged: Record<string, number>,
  monthlyClosed: Record<string, number>,
  monthlyOpened: Record<string, number>,
  digest: DailyDigest,
  state: Readonly<AgentState>,
): string {
  const approachingDormantDays = state.config?.approachingDormantDays ?? 25;
  // Action Required: contributor must do something
  const actionRequired = [
    ...(digest.prsNeedingResponse || []),
    ...(digest.needsChangesPRs || []),
    ...(digest.ciFailingPRs || []),
    ...(digest.mergeConflictPRs || []),
    ...(digest.incompleteChecklistPRs || []),
    ...(digest.missingRequiredFilesPRs || []),
    ...(digest.needsRebasePRs || []),
  ];

  // Waiting on Others: informational, no contributor action needed
  const waitingOnOthers = [
    ...(digest.changesAddressedPRs || []),
    ...(digest.waitingOnMaintainerPRs || []),
    ...(digest.ciBlockedPRs || []),
    ...(digest.ciNotRunningPRs || []),
  ];

  function truncateTitle(title: string, max: number = 50): string {
    const truncated = title.length <= max ? title : title.slice(0, max) + '...';
    return escapeHtml(truncated);
  }

  /**
   * Render health status items. labelFn output is automatically HTML-escaped.
   * metaFn output is injected raw — callers must ensure metaFn returns safe HTML
   * (use escapeHtml for any user-controlled content within metaFn).
   */
  function renderHealthItems(
    prs: FetchedPR[],
    cssClass: string,
    svgPaths: string,
    labelFn: string | ((pr: FetchedPR) => string),
    metaFn: (pr: FetchedPR) => string,
  ): string {
    return prs.map(pr => {
      const rawLabel = typeof labelFn === 'string' ? labelFn : labelFn(pr);
      const label = escapeHtml(rawLabel);
      return `
        <div class="health-item ${cssClass}">
          <div class="health-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${svgPaths}
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${escapeHtml(pr.url)}" target="_blank">${escapeHtml(pr.repo)}#${pr.number}</a> - ${label}</div>
            <div class="health-meta">${metaFn(pr)}</div>
          </div>
        </div>`;
    }).join('');
  }

  // SVG path constants for health item icons
  const SVG = {
    comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
    xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
    conflict: '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
    checklist: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
    checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
    clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    infoCircle: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    refresh: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  };

  // Default meta: truncated PR title
  const titleMeta = (pr: FetchedPR): string => truncateTitle(pr.title);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OSS Autopilot - Mission Control</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #080b10;
      --bg-surface: rgba(22, 27, 34, 0.65);
      --bg-elevated: rgba(28, 33, 40, 0.8);
      --border: rgba(48, 54, 61, 0.6);
      --border-muted: rgba(33, 38, 45, 0.5);
      --text-primary: #e6edf3;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-merged: #a855f7;
      --accent-merged-dim: rgba(168, 85, 247, 0.12);
      --accent-open: #3fb950;
      --accent-open-dim: rgba(63, 185, 80, 0.12);
      --accent-warning: #d29922;
      --accent-warning-dim: rgba(210, 153, 34, 0.12);
      --accent-error: #f85149;
      --accent-error-dim: rgba(248, 81, 73, 0.10);
      --accent-conflict: #da3633;
      --accent-info: #58a6ff;
      --accent-info-dim: rgba(88, 166, 255, 0.08);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
      overflow-x: hidden;
    }

    body::before {
      content: '';
      position: fixed;
      top: -20%; left: -10%;
      width: 60%; height: 60%;
      background: radial-gradient(ellipse, rgba(88, 166, 255, 0.06) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    body::after {
      content: '';
      position: fixed;
      bottom: -20%; right: -10%;
      width: 50%; height: 50%;
      background: radial-gradient(ellipse, rgba(168, 85, 247, 0.05) 0%, transparent 70%);
      pointer-events: none;
      z-index: 0;
    }

    .container {
      max-width: 1400px;
      margin: 0 auto;
      padding: 2rem;
      position: relative;
      z-index: 1;
    }

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 1.5rem;
      padding-bottom: 1rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo {
      width: 44px;
      height: 44px;
      background: linear-gradient(135deg, var(--accent-info) 0%, var(--accent-merged) 50%, #f778ba 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      box-shadow: 0 0 24px rgba(168, 85, 247, 0.3), 0 0 48px rgba(88, 166, 255, 0.15);
    }

    .header h1 {
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.02em;
      background: linear-gradient(135deg, var(--text-primary) 0%, var(--text-secondary) 100%);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
    }

    .header-subtitle {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }

    .timestamp {
      font-family: 'Geist Mono', monospace;
      font-size: 0.8rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .timestamp::before {
      content: '';
      width: 8px;
      height: 8px;
      background: var(--accent-open);
      border-radius: 50%;
      animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(35, 134, 54, 0.4); }
      50% { opacity: 0.8; box-shadow: 0 0 0 8px rgba(35, 134, 54, 0); }
    }

    .stats-grid {
      display: flex;
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      margin-bottom: 1.5rem;
      overflow: hidden;
    }

    @media (max-width: 768px) {
      .stats-grid { flex-wrap: wrap; }
      .stat-card { flex: 1 1 33%; }
    }

    .stat-card {
      flex: 1;
      padding: 1rem 1.25rem;
      position: relative;
      transition: background 0.2s ease;
    }

    .stat-card + .stat-card {
      border-left: 1px solid var(--border-muted);
    }

    .stat-card:hover {
      background: rgba(255, 255, 255, 0.02);
    }

    .stat-card::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0.75rem; right: 0.75rem;
      height: 2px;
      background: var(--accent-color, var(--border));
      border-radius: 2px;
      opacity: 0.7;
    }

    .stat-card.active { --accent-color: var(--accent-open); }
    .stat-card.dormant { --accent-color: var(--accent-warning); }
    .stat-card.merged { --accent-color: var(--accent-merged); }
    .stat-card.closed { --accent-color: var(--text-muted); }
    .stat-card.rate { --accent-color: var(--accent-info); }
    .stat-card.response { --accent-color: var(--accent-warning); }

    .stat-value {
      font-family: 'Geist Mono', monospace;
      font-size: 1.75rem;
      font-weight: 600;
      line-height: 1;
      margin-bottom: 0.25rem;
    }

    .stat-card.active .stat-value { color: var(--accent-open); }
    .stat-card.dormant .stat-value { color: var(--accent-warning); }
    .stat-card.merged .stat-value { color: var(--accent-merged); }
    .stat-card.closed .stat-value { color: var(--text-muted); }
    .stat-card.rate .stat-value { color: var(--accent-info); }
    .stat-card.response .stat-value { color: var(--accent-warning); }

    .stat-label {
      font-size: 0.7rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .health-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      padding: 1.25rem;
      margin-bottom: 1.25rem;
    }

    .health-header {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .health-header h2 {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .health-badge {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      padding: 0.25rem 0.5rem;
      border-radius: 4px;
      background: var(--accent-error-dim);
      color: var(--accent-error);
    }

    .health-items {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
      gap: 0.75rem;
    }

    .health-item {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      padding: 0.75rem 1rem;
      background: var(--bg-elevated);
      border-radius: 8px;
      border-left: 3px solid;
      transition: transform 0.15s ease;
    }

    .health-item:hover { transform: translateX(4px); }

    .health-item.ci-failing {
      border-left-color: var(--accent-error);
      background: var(--accent-error-dim);
    }

    .health-item.conflict {
      border-left-color: var(--accent-conflict);
      background: rgba(218, 54, 51, 0.1);
    }

    .health-item.incomplete-checklist {
      border-left-color: var(--accent-info);
    }
    .health-item.needs-response,
    .health-item.needs-changes {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .health-item.changes-addressed,
    .health-item.waiting-maintainer {
      border-left-color: var(--accent-info);
      background: var(--accent-info-dim);
    }

    .health-item.ci-not-running {
      border-left-color: var(--text-muted);
      background: rgba(110, 118, 129, 0.1);
    }

    .health-item.missing-files {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .health-item.ci-blocked {
      border-left-color: var(--text-muted);
      background: rgba(110, 118, 129, 0.1);
    }

    .health-item.needs-rebase {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
    }

    .waiting-section {
      border-color: rgba(88, 166, 255, 0.2);
    }

    .health-icon {
      width: 32px;
      height: 32px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1rem;
      flex-shrink: 0;
    }

    .health-item.ci-failing .health-icon { background: var(--accent-error-dim); color: var(--accent-error); }
    .health-item.conflict .health-icon { background: rgba(218, 54, 51, 0.15); color: var(--accent-conflict); }
    .health-item.incomplete-checklist .health-icon { background: var(--accent-info-dim); color: var(--accent-info); }
    .health-item.needs-response .health-icon,
    .health-item.needs-changes .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .health-item.changes-addressed .health-icon,
    .health-item.waiting-maintainer .health-icon { background: var(--accent-info-dim); color: var(--accent-info); }
    .health-item.ci-not-running .health-icon { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); }
    .health-item.missing-files .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .health-item.ci-blocked .health-icon { background: rgba(110, 118, 129, 0.15); color: var(--text-muted); }
    .health-item.needs-rebase .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }

    .health-content { flex: 1; min-width: 0; }

    .health-title {
      font-size: 0.85rem;
      font-weight: 500;
      color: var(--text-primary);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .health-title a { color: inherit; text-decoration: none; }
    .health-title a:hover { color: var(--accent-info); }

    .health-meta {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    .health-empty {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2rem;
      color: var(--text-muted);
      font-size: 0.9rem;
    }

    .health-empty::before {
      content: '\\2713';
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      background: var(--accent-open-dim);
      color: var(--accent-open);
      border-radius: 50%;
      margin-right: 0.75rem;
      font-weight: bold;
    }

    .main-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.25rem;
      margin-bottom: 1.25rem;
    }

    @media (max-width: 1024px) { .main-grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.125rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .card-title {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .card-body { padding: 1rem 1.125rem; }

    .chart-container {
      position: relative;
      height: 260px;
    }

    .pr-list-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 10px;
      overflow: hidden;
    }

    .pr-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0.75rem 1.125rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .pr-list-title {
      font-size: 0.75rem;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .pr-count {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      padding: 0.25rem 0.5rem;
      background: var(--accent-open-dim);
      color: var(--accent-open);
      border-radius: 4px;
    }

    .pr-list {
      max-height: 600px;
      overflow-y: auto;
    }

    .pr-list::-webkit-scrollbar { width: 6px; }
    .pr-list::-webkit-scrollbar-track { background: var(--bg-elevated); }
    .pr-list::-webkit-scrollbar-thumb { background: var(--border); border-radius: 3px; }

    .pr-item {
      display: flex;
      align-items: flex-start;
      gap: 1rem;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-muted);
      transition: background 0.15s ease;
    }

    .pr-item:last-child { border-bottom: none; }
    .pr-item:hover { background: var(--bg-elevated); }

    .pr-status-indicator {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 1.1rem;
      background: var(--accent-open-dim);
      color: var(--accent-open);
    }

    .pr-item.has-issues .pr-status-indicator {
      background: var(--accent-error-dim);
      color: var(--accent-error);
      animation: attention-pulse 2s ease-in-out infinite;
    }

    .pr-item.stale .pr-status-indicator {
      background: var(--accent-warning-dim);
      color: var(--accent-warning);
    }

    @keyframes attention-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(248, 81, 73, 0.4); }
      50% { box-shadow: 0 0 0 6px rgba(248, 81, 73, 0); }
    }

    .pr-content { flex: 1; min-width: 0; }

    .pr-title-row {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
    }

    .pr-title {
      font-size: 0.9rem;
      font-weight: 500;
      color: var(--text-primary);
      text-decoration: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .pr-title:hover { color: var(--accent-info); }

    .pr-repo {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .pr-badges {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
    }

    .badge {
      font-family: 'Geist Mono', monospace;
      font-size: 0.65rem;
      font-weight: 500;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .badge-ci-failing { background: var(--accent-error-dim); color: var(--accent-error); }
    .badge-conflict { background: rgba(218, 54, 51, 0.15); color: var(--accent-conflict); }
    .badge-needs-response { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-stale { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-passing { background: var(--accent-open-dim); color: var(--accent-open); }
    .badge-pending { background: var(--accent-info-dim); color: var(--accent-info); }
    .badge-days { background: var(--bg-elevated); color: var(--text-muted); }
    .badge-changes-requested { background: var(--accent-warning-dim); color: var(--accent-warning); }
    .badge-changes-addressed { background: var(--accent-info-dim); color: var(--accent-info); }

    .pr-activity {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
      margin-left: auto;
      text-align: right;
      flex-shrink: 0;
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 3rem;
      color: var(--text-muted);
    }

    .empty-state-icon {
      font-size: 2.5rem;
      margin-bottom: 1rem;
      opacity: 0.5;
    }

    .footer {
      text-align: center;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border-muted);
      margin-top: 1.5rem;
    }

    .footer p {
      font-family: 'Geist Mono', monospace;
      font-size: 0.7rem;
      color: var(--text-muted);
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stats-grid, .health-section, .pr-list-section {
      animation: fadeInUp 0.35s ease;
    }
  </style>
</head>
<body>
  <div class="container">
    <header class="header">
      <div class="header-left">
        <div class="logo">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 6v6l4 2"/>
          </svg>
        </div>
        <div>
          <h1>OSS Autopilot</h1>
          <span class="header-subtitle">Mission Control</span>
        </div>
      </div>
      <div class="timestamp">
        ${digest.generatedAt ? new Date(digest.generatedAt).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }) : 'Unknown'}
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card active">
        <div class="stat-value">${stats.activePRs}</div>
        <div class="stat-label">Active PRs</div>
      </div>
      <div class="stat-card dormant">
        <div class="stat-value">${stats.dormantPRs}</div>
        <div class="stat-label">Dormant</div>
      </div>
      <div class="stat-card merged">
        <div class="stat-value">${stats.mergedPRs}</div>
        <div class="stat-label">Merged</div>
      </div>
      <div class="stat-card closed">
        <div class="stat-value">${stats.closedPRs}</div>
        <div class="stat-label">Closed</div>
      </div>
      <div class="stat-card rate">
        <div class="stat-value">${stats.mergeRate}</div>
        <div class="stat-label">Merge Rate</div>
      </div>
      <div class="stat-card response">
        <div class="stat-value">${stats.needsResponse}</div>
        <div class="stat-label">Need Response</div>
      </div>
    </div>

    ${actionRequired.length > 0 ? `
    <section class="health-section">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <h2>Action Required</h2>
        <span class="health-badge">${actionRequired.length} issue${actionRequired.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="health-items">
        ${renderHealthItems(digest.prsNeedingResponse || [], 'needs-response', SVG.comment, 'Needs Response',
          pr => pr.lastMaintainerComment ? `@${escapeHtml(pr.lastMaintainerComment.author)}: ${truncateTitle(pr.lastMaintainerComment.body, 40)}` : truncateTitle(pr.title))}
        ${renderHealthItems(digest.needsChangesPRs || [], 'needs-changes', SVG.edit, 'Needs Changes', titleMeta)}
        ${renderHealthItems(digest.ciFailingPRs || [], 'ci-failing', SVG.xCircle, 'CI Failing', titleMeta)}
        ${renderHealthItems(digest.mergeConflictPRs || [], 'conflict', SVG.conflict, 'Merge Conflict', titleMeta)}
        ${renderHealthItems(digest.incompleteChecklistPRs || [], 'incomplete-checklist', SVG.checklist,
          pr => `Incomplete Checklist${pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : ''}`, titleMeta)}
        ${renderHealthItems(digest.missingRequiredFilesPRs || [], 'missing-files', SVG.file, 'Missing Required Files',
          pr => pr.missingRequiredFiles ? escapeHtml(pr.missingRequiredFiles.join(', ')) : truncateTitle(pr.title))}
        ${renderHealthItems(digest.needsRebasePRs || [], 'needs-rebase', SVG.refresh,
          pr => `Needs Rebase${pr.commitsBehindUpstream ? ` (${pr.commitsBehindUpstream} behind)` : ''}`, titleMeta)}
      </div>
    </section>
    ` : ''}

    ${waitingOnOthers.length > 0 ? `
    <section class="health-section waiting-section">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-info)" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <polyline points="12 6 12 12 16 14"/>
        </svg>
        <h2>Waiting on Others</h2>
        <span class="health-badge" style="background: var(--accent-info-dim); color: var(--accent-info);">${waitingOnOthers.length} PR${waitingOnOthers.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="health-items">
        ${renderHealthItems(digest.changesAddressedPRs || [], 'changes-addressed', SVG.checkCircle, 'Changes Addressed',
          pr => `Awaiting re-review${pr.lastMaintainerComment ? ` from @${escapeHtml(pr.lastMaintainerComment.author)}` : ''}`)}
        ${renderHealthItems(digest.waitingOnMaintainerPRs || [], 'waiting-maintainer', SVG.clock, 'Waiting on Maintainer', titleMeta)}
        ${renderHealthItems(digest.ciBlockedPRs || [], 'ci-blocked', SVG.lock, 'CI Blocked', titleMeta)}
        ${renderHealthItems(digest.ciNotRunningPRs || [], 'ci-not-running', SVG.infoCircle, 'CI Not Running', titleMeta)}
      </div>
    </section>
    ` : ''}

    ${actionRequired.length === 0 && waitingOnOthers.length === 0 ? `
    <section class="health-section">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-open)" stroke-width="2">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <h2>Health Status</h2>
      </div>
      <div class="health-empty">
        All PRs are healthy - no CI failures, conflicts, or pending responses
      </div>
    </section>
    ` : ''}

    ${(digest.recentlyClosedPRs || []).length > 0 ? `
    <section class="health-section" style="animation-delay: 0.2s;">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="2">
          <circle cx="12" cy="12" r="10"/>
          <line x1="15" y1="9" x2="9" y2="15"/>
          <line x1="9" y1="9" x2="15" y2="15"/>
        </svg>
        <h2>Recently Closed</h2>
        <span class="health-badge" style="background: rgba(110, 118, 129, 0.15); color: var(--text-muted);">${(digest.recentlyClosedPRs || []).length} closed</span>
      </div>
      <div class="health-items">
        ${(digest.recentlyClosedPRs || []).map(pr => `
        <div class="health-item" style="border-left-color: var(--text-muted); opacity: 0.7;">
          <div class="health-icon" style="background: rgba(110, 118, 129, 0.15); color: var(--text-muted);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${escapeHtml(pr.url)}" target="_blank">${escapeHtml(pr.repo)}#${pr.number}</a> - Closed</div>
            <div class="health-meta">${escapeHtml(pr.title.slice(0, 50))}${pr.title.length > 50 ? '...' : ''}${pr.closedAt ? ` · ${new Date(pr.closedAt).toLocaleDateString()}` : ''}</div>
          </div>
        </div>
        `).join('')}
      </div>
    </section>
    ` : ''}

    <div class="main-grid">
      <div class="card">
        <div class="card-header">
          <span class="card-title">PR Status Distribution</span>
        </div>
        <div class="card-body">
          <div class="chart-container">
            <canvas id="statusChart"></canvas>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <span class="card-title">Repository Breakdown</span>
        </div>
        <div class="card-body">
          <div class="chart-container">
            <canvas id="reposChart"></canvas>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 1.25rem;">
      <div class="card-header">
        <span class="card-title">Contribution Timeline</span>
      </div>
      <div class="card-body">
        <div class="chart-container" style="height: 250px;">
          <canvas id="monthlyChart"></canvas>
        </div>
      </div>
    </div>


    ${(digest.openPRs || []).length > 0 ? `
    <section class="pr-list-section">
      <div class="pr-list-header">
        <h2 class="pr-list-title">Active Pull Requests</h2>
        <span class="pr-count">${(digest.openPRs || []).length} open</span>
      </div>
      <div class="pr-list">
        ${(digest.openPRs || []).map(pr => {
          const hasIssues = pr.ciStatus === 'failing' || pr.hasMergeConflict || (pr.hasUnrespondedComment && pr.status !== 'changes_addressed') || pr.status === 'needs_changes';
          const isStale = pr.daysSinceActivity >= approachingDormantDays;
          const itemClass = hasIssues ? 'has-issues' : (isStale ? 'stale' : '');

          return `
        <div class="pr-item ${itemClass}">
          <div class="pr-status-indicator">
            ${hasIssues ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            ` : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            `}
          </div>
          <div class="pr-content">
            <div class="pr-title-row">
              <a href="${escapeHtml(pr.url)}" target="_blank" class="pr-title">${escapeHtml(pr.title)}</a>
              <span class="pr-repo">${escapeHtml(pr.repo)}#${pr.number}</span>
            </div>
            <div class="pr-badges">
              ${pr.ciStatus === 'failing' ? '<span class="badge badge-ci-failing">CI Failing</span>' : ''}
              ${pr.ciStatus === 'passing' ? '<span class="badge badge-passing">CI Passing</span>' : ''}
              ${pr.ciStatus === 'pending' ? '<span class="badge badge-pending">CI Pending</span>' : ''}
              ${pr.hasMergeConflict ? '<span class="badge badge-conflict">Merge Conflict</span>' : ''}
              ${pr.hasUnrespondedComment && pr.status === 'changes_addressed' ? '<span class="badge badge-changes-addressed">Changes Addressed</span>' : ''}
              ${pr.hasUnrespondedComment && pr.status !== 'changes_addressed' ? '<span class="badge badge-needs-response">Needs Response</span>' : ''}
              ${pr.reviewDecision === 'changes_requested' ? '<span class="badge badge-changes-requested">Changes Requested</span>' : ''}
              ${isStale ? `<span class="badge badge-stale">${pr.daysSinceActivity}d inactive</span>` : ''}
            </div>
          </div>
          <div class="pr-activity">
            ${pr.daysSinceActivity === 0 ? 'Today' : (pr.daysSinceActivity === 1 ? 'Yesterday' : pr.daysSinceActivity + 'd ago')}
          </div>
        </div>`;
        }).join('')}
      </div>
    </section>
    ` : `
    <section class="pr-list-section">
      <div class="pr-list-header">
        <h2 class="pr-list-title">Active Pull Requests</h2>
        <span class="pr-count">0 open</span>
      </div>
      <div class="empty-state">
        <div class="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"/>
            <path d="M8 12h8"/>
          </svg>
        </div>
        <p>No active pull requests</p>
      </div>
    </section>
    `}

    <footer class="footer">
      <p>OSS Autopilot // Mission Control</p>
    </footer>
  </div>

  <script>
    Chart.defaults.color = '#6e7681';
    Chart.defaults.borderColor = 'rgba(48, 54, 61, 0.4)';
    Chart.defaults.font.family = "'Geist', sans-serif";
    Chart.defaults.font.size = 11;

    // === Status Doughnut ===
    new Chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: {
        labels: ['Active', 'Dormant', 'Merged', 'Closed'],
        datasets: [{
          data: [${stats.activePRs}, ${stats.dormantPRs}, ${stats.mergedPRs}, ${stats.closedPRs}],
          backgroundColor: ['#3fb950', '#d29922', '#a855f7', '#484f58'],
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
    });

    // === Repository Breakdown (with "Other" bucket + percentage tooltips) ===
    ${(() => {
      // Sort repos by total PRs (merged + active + closed) and build "Other" bucket
      const allRepoEntries = Object.entries(
        // Rebuild from full prsByRepo to get all repos, not just top 10
        (() => {
          const all: Record<string, { active: number; merged: number; closed: number }> = {};
          for (const pr of (digest.openPRs || [])) {
            if (!all[pr.repo]) all[pr.repo] = { active: 0, merged: 0, closed: 0 };
            all[pr.repo].active++;
          }
          for (const [repo, score] of Object.entries(state.repoScores || {})) {
            if (!all[repo]) all[repo] = { active: 0, merged: 0, closed: 0 };
            all[repo].merged = score.mergedPRCount;
            all[repo].closed = score.closedWithoutMergeCount;
          }
          return all;
        })()
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
          (acc, [, d]) => ({ active: acc.active + d.active, merged: acc.merged + d.merged, closed: acc.closed + d.closed }),
          { active: 0, merged: 0, closed: 0 }
        );
        displayRepos.push(['Other', otherData]);
      }

      const repoLabels = displayRepos.map(([repo]) => repo === 'Other' ? 'Other' : (repo.split('/')[1] || repo));
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
    })()}

    // === Contribution Timeline (grouped bar: Opened/Merged/Closed) ===
    ${(() => {
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
    })()}

  </script>
</body>
</html>`;
}

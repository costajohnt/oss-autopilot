/**
 * Dashboard command
 * Generates HTML stats dashboard from latest digest
 * v2: Fetches fresh data from GitHub if token available, otherwise uses cached lastDigest
 */

import * as fs from 'fs';
import { execFile } from 'child_process';
import { getStateManager, getDashboardPath, PRMonitor, getGitHubToken } from '../core/index.js';
import { outputJson } from '../formatters/json.js';
import type { FetchedPR, DailyDigest, AgentState, RepoScore } from '../core/types.js';

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
      const { prs, failures } = await prMonitor.fetchUserOpenPRs();

      if (failures.length > 0) {
        console.error(`Warning: ${failures.length} PR fetch(es) failed`);
      }

      digest = prMonitor.generateDigest(prs);
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
  for (const pr of digest.openPRs) {
    if (!prsByRepo[pr.repo]) prsByRepo[pr.repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[pr.repo].active++;
  }

  // Add merged/closed counts from repo scores (historical data)
  for (const [repo, score] of Object.entries(state.repoScores)) {
    if (!prsByRepo[repo]) prsByRepo[repo] = { active: 0, merged: 0, closed: 0 };
    prsByRepo[repo].merged = score.mergedPRCount;
    prsByRepo[repo].closed = score.closedWithoutMergeCount;
  }

  // Sort repos by total merged
  const topRepos = Object.entries(prsByRepo)
    .sort((a, b) => b[1].merged - a[1].merged)
    .slice(0, 10);

  // Monthly activity from repo scores (approximation based on lastMergedAt)
  const monthlyMerged: Record<string, number> = {};
  for (const score of Object.values(state.repoScores)) {
    if (score.lastMergedAt) {
      const month = score.lastMergedAt.slice(0, 7);
      monthlyMerged[month] = (monthlyMerged[month] || 0) + 1;
    }
  }

  // Build stats from digest
  const stats = {
    activePRs: digest.summary.totalActivePRs,
    dormantPRs: digest.dormantPRs.length,
    mergedPRs: digest.summary.totalMergedAllTime,
    closedPRs: Object.values(state.repoScores).reduce((sum, s) => sum + s.closedWithoutMergeCount, 0),
    mergeRate: `${digest.summary.mergeRate.toFixed(1)}%`,
    needsResponse: digest.prsNeedingResponse.length,
  };

  if (options.json) {
    outputJson({
      stats,
      prsByRepo,
      topRepos: topRepos.map(([repo, data]) => ({ repo, ...data })),
      monthlyMerged,
      activePRs: digest.openPRs,
    });
    return;
  }

  const html = generateDashboardHtml(stats, topRepos, monthlyMerged, digest, state.config.approachingDormantDays);

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

function generateDashboardHtml(
  stats: DashboardStats,
  topRepos: Array<[string, { active: number; merged: number; closed: number }]>,
  monthlyMerged: Record<string, number>,
  digest: DailyDigest,
  approachingDormantDays: number = 25
): string {
  // Health issues from digest
  const healthIssues = [
    ...digest.ciFailingPRs,
    ...digest.mergeConflictPRs,
    ...digest.prsNeedingResponse,
  ];

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
      --bg-base: #0d1117;
      --bg-surface: #161b22;
      --bg-elevated: #1c2128;
      --border: #30363d;
      --border-muted: #21262d;
      --text-primary: #c9d1d9;
      --text-secondary: #8b949e;
      --text-muted: #6e7681;
      --accent-merged: #a855f7;
      --accent-merged-dim: rgba(168, 85, 247, 0.15);
      --accent-open: #238636;
      --accent-open-dim: rgba(35, 134, 54, 0.15);
      --accent-warning: #d29922;
      --accent-warning-dim: rgba(210, 153, 34, 0.15);
      --accent-error: #f85149;
      --accent-error-dim: rgba(248, 81, 73, 0.15);
      --accent-conflict: #da3633;
      --accent-info: #58a6ff;
      --accent-info-dim: rgba(88, 166, 255, 0.1);
      --glow-merged: 0 0 20px rgba(168, 85, 247, 0.3);
      --glow-open: 0 0 20px rgba(35, 134, 54, 0.3);
      --glow-warning: 0 0 20px rgba(210, 153, 34, 0.3);
      --glow-error: 0 0 20px rgba(248, 81, 73, 0.3);
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: 'Geist', -apple-system, BlinkMacSystemFont, sans-serif;
      background: var(--bg-base);
      color: var(--text-primary);
      min-height: 100vh;
      line-height: 1.5;
    }

    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background-image:
        linear-gradient(rgba(88, 166, 255, 0.02) 1px, transparent 1px),
        linear-gradient(90deg, rgba(88, 166, 255, 0.02) 1px, transparent 1px);
      background-size: 50px 50px;
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
      margin-bottom: 2.5rem;
      padding-bottom: 1.5rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: 1rem;
    }

    .logo {
      width: 48px;
      height: 48px;
      background: linear-gradient(135deg, var(--accent-info) 0%, var(--accent-merged) 100%);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 1.5rem;
      box-shadow: var(--glow-merged);
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
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 1rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 1200px) { .stats-grid { grid-template-columns: repeat(3, 1fr); } }
    @media (max-width: 768px) { .stats-grid { grid-template-columns: repeat(2, 1fr); } }

    .stat-card {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      padding: 1.25rem;
      position: relative;
      overflow: hidden;
      transition: all 0.2s ease;
    }

    .stat-card:hover {
      border-color: var(--border);
      transform: translateY(-2px);
    }

    .stat-card::before {
      content: '';
      position: absolute;
      top: 0; left: 0; right: 0;
      height: 3px;
      background: var(--accent-color, var(--border));
      opacity: 0.8;
    }

    .stat-card.active { --accent-color: var(--accent-open); }
    .stat-card.dormant { --accent-color: var(--accent-warning); }
    .stat-card.merged { --accent-color: var(--accent-merged); }
    .stat-card.closed { --accent-color: var(--text-muted); }
    .stat-card.rate { --accent-color: var(--accent-info); }
    .stat-card.response { --accent-color: var(--accent-warning); }

    .stat-value {
      font-family: 'Geist Mono', monospace;
      font-size: 2.25rem;
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
      font-size: 0.8rem;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .health-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      padding: 1.5rem;
      margin-bottom: 2rem;
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

    .health-item.needs-response {
      border-left-color: var(--accent-warning);
      background: var(--accent-warning-dim);
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
    .health-item.needs-response .health-icon { background: var(--accent-warning-dim); color: var(--accent-warning); }

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
      gap: 1.5rem;
      margin-bottom: 2rem;
    }

    @media (max-width: 1024px) { .main-grid { grid-template-columns: 1fr; } }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      overflow: hidden;
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .card-title {
      font-size: 0.9rem;
      font-weight: 600;
      color: var(--text-primary);
    }

    .card-body { padding: 1.25rem; }

    .chart-container {
      position: relative;
      height: 280px;
    }

    .pr-list-section {
      background: var(--bg-surface);
      border: 1px solid var(--border-muted);
      border-radius: 12px;
      overflow: hidden;
    }

    .pr-list-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border-muted);
    }

    .pr-list-title { font-size: 1rem; font-weight: 600; }

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
      padding-top: 2rem;
      border-top: 1px solid var(--border-muted);
      margin-top: 2rem;
    }

    .footer p {
      font-family: 'Geist Mono', monospace;
      font-size: 0.75rem;
      color: var(--text-muted);
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .stat-card { animation: fadeInUp 0.4s ease forwards; }
    .stat-card:nth-child(1) { animation-delay: 0.05s; }
    .stat-card:nth-child(2) { animation-delay: 0.1s; }
    .stat-card:nth-child(3) { animation-delay: 0.15s; }
    .stat-card:nth-child(4) { animation-delay: 0.2s; }
    .stat-card:nth-child(5) { animation-delay: 0.25s; }
    .stat-card:nth-child(6) { animation-delay: 0.3s; }

    .card, .pr-list-section, .health-section {
      animation: fadeInUp 0.5s ease forwards;
      animation-delay: 0.35s;
      opacity: 0;
    }

    .pr-list-section { animation-delay: 0.45s; }
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
          <span class="header-subtitle">Contribution Dashboard</span>
        </div>
      </div>
      <div class="timestamp">
        ${new Date(digest.generatedAt).toLocaleString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        })}
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

    ${healthIssues.length > 0 ? `
    <section class="health-section">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-warning)" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <h2>Attention Required</h2>
        <span class="health-badge">${healthIssues.length} issue${healthIssues.length !== 1 ? 's' : ''}</span>
      </div>
      <div class="health-items">
        ${digest.ciFailingPRs.map(pr => `
        <div class="health-item ci-failing">
          <div class="health-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${pr.url}" target="_blank">${pr.repo}#${pr.number}</a> - CI Failing</div>
            <div class="health-meta">${pr.title.slice(0, 50)}${pr.title.length > 50 ? '...' : ''}</div>
          </div>
        </div>
        `).join('')}
        ${digest.mergeConflictPRs.map(pr => `
        <div class="health-item conflict">
          <div class="health-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M8 3v3a2 2 0 0 1-2 2H3"/>
              <path d="M21 8h-3a2 2 0 0 1-2-2V3"/>
              <path d="M3 16h3a2 2 0 0 1 2 2v3"/>
              <path d="M16 21v-3a2 2 0 0 1 2-2h3"/>
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${pr.url}" target="_blank">${pr.repo}#${pr.number}</a> - Merge Conflict</div>
            <div class="health-meta">${pr.title.slice(0, 50)}${pr.title.length > 50 ? '...' : ''}</div>
          </div>
        </div>
        `).join('')}
        ${digest.prsNeedingResponse.map(pr => `
        <div class="health-item needs-response">
          <div class="health-icon">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${pr.url}" target="_blank">${pr.repo}#${pr.number}</a> - Needs Response</div>
            <div class="health-meta">${pr.lastMaintainerComment ? `@${pr.lastMaintainerComment.author}: ${pr.lastMaintainerComment.body.slice(0, 40)}...` : pr.title.slice(0, 50)}</div>
          </div>
        </div>
        `).join('')}
      </div>
    </section>
    ` : `
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
    `}

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
          <span class="card-title">Top Repositories</span>
        </div>
        <div class="card-body">
          <div class="chart-container">
            <canvas id="reposChart"></canvas>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="margin-bottom: 2rem;">
      <div class="card-header">
        <span class="card-title">Contribution Timeline</span>
      </div>
      <div class="card-body">
        <div class="chart-container" style="height: 200px;">
          <canvas id="monthlyChart"></canvas>
        </div>
      </div>
    </div>

    ${digest.openPRs.length > 0 ? `
    <section class="pr-list-section">
      <div class="pr-list-header">
        <h2 class="pr-list-title">Active Pull Requests</h2>
        <span class="pr-count">${digest.openPRs.length} open</span>
      </div>
      <div class="pr-list">
        ${digest.openPRs.map(pr => {
          const hasIssues = pr.ciStatus === 'failing' || pr.hasMergeConflict || pr.hasUnrespondedComment;
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
              <a href="${pr.url}" target="_blank" class="pr-title">${pr.title}</a>
              <span class="pr-repo">${pr.repo}#${pr.number}</span>
            </div>
            <div class="pr-badges">
              ${pr.ciStatus === 'failing' ? '<span class="badge badge-ci-failing">CI Failing</span>' : ''}
              ${pr.ciStatus === 'passing' ? '<span class="badge badge-passing">CI Passing</span>' : ''}
              ${pr.ciStatus === 'pending' ? '<span class="badge badge-pending">CI Pending</span>' : ''}
              ${pr.hasMergeConflict ? '<span class="badge badge-conflict">Merge Conflict</span>' : ''}
              ${pr.hasUnrespondedComment ? '<span class="badge badge-needs-response">Needs Response</span>' : ''}
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
      <p>OSS Autopilot Dashboard // Built for open source contributors</p>
    </footer>
  </div>

  <script>
    Chart.defaults.color = '#8b949e';
    Chart.defaults.borderColor = '#30363d';
    Chart.defaults.font.family = "'Geist', sans-serif";

    new Chart(document.getElementById('statusChart'), {
      type: 'doughnut',
      data: {
        labels: ['Active', 'Dormant', 'Merged', 'Closed'],
        datasets: [{
          data: [${stats.activePRs}, ${stats.dormantPRs}, ${stats.mergedPRs}, ${stats.closedPRs}],
          backgroundColor: ['#238636', '#d29922', '#a855f7', '#6e7681'],
          borderColor: '#161b22',
          borderWidth: 3,
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
            labels: { padding: 20, usePointStyle: true, pointStyle: 'circle' }
          }
        }
      }
    });

    new Chart(document.getElementById('reposChart'), {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(topRepos.map(([repo]) => repo.split('/')[1] || repo))},
        datasets: [
          { label: 'Merged', data: ${JSON.stringify(topRepos.map(([, data]) => data.merged))}, backgroundColor: '#a855f7', borderRadius: 4 },
          { label: 'Active', data: ${JSON.stringify(topRepos.map(([, data]) => data.active))}, backgroundColor: '#238636', borderRadius: 4 },
          { label: 'Closed', data: ${JSON.stringify(topRepos.map(([, data]) => data.closed))}, backgroundColor: '#6e7681', borderRadius: 4 }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { stacked: true, grid: { color: '#21262d' }, ticks: { stepSize: 1 } }
        },
        plugins: {
          legend: { position: 'bottom', labels: { padding: 20, usePointStyle: true, pointStyle: 'circle' } }
        }
      }
    });

    const months = ${JSON.stringify(Object.keys(monthlyMerged).sort())};
    const monthlyData = ${JSON.stringify(monthlyMerged)};
    new Chart(document.getElementById('monthlyChart'), {
      type: 'line',
      data: {
        labels: months,
        datasets: [{
          label: 'Merged PRs',
          data: months.map(m => monthlyData[m] || 0),
          borderColor: '#a855f7',
          backgroundColor: 'rgba(168, 85, 247, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 4,
          pointBackgroundColor: '#a855f7',
          pointBorderColor: '#161b22',
          pointBorderWidth: 2,
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: { grid: { display: false } },
          y: { grid: { color: '#21262d' }, beginAtZero: true, ticks: { stepSize: 1 } }
        },
        plugins: { legend: { display: false } },
        interaction: { intersect: false, mode: 'index' }
      }
    });
  </script>
</body>
</html>`;
}

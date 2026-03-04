/**
 * Dashboard HTML template assembly.
 * Imports styles, components, formatters, and scripts from focused sub-modules,
 * then weaves them into the final HTML document.
 *
 * Pure functions with no side effects — all data is passed in as arguments.
 */

import type { DailyDigest, AgentState, CommentedIssueWithResponse } from '../core/types.js';

import { escapeHtml } from './dashboard-formatters.js';
import type { DashboardStats } from './dashboard-data.js';
import { DASHBOARD_CSS } from './dashboard-styles.js';
import { SVG_ICONS, truncateTitle, renderHealthItems, titleMeta } from './dashboard-components.js';
import { generateDashboardScripts } from './dashboard-scripts.js';

// Re-export public API so consumers can import from this module
export { escapeHtml } from './dashboard-formatters.js';
export { buildDashboardStats, type DashboardStats } from './dashboard-data.js';

export function generateDashboardHtml(
  stats: DashboardStats,
  monthlyMerged: Record<string, number>,
  monthlyClosed: Record<string, number>,
  monthlyOpened: Record<string, number>,
  digest: DailyDigest,
  state: Readonly<AgentState>,
  issueResponses: CommentedIssueWithResponse[] = [],
): string {
  const approachingDormantDays = state.config?.approachingDormantDays ?? 25;
  const shelvedPRs = digest.shelvedPRs || [];
  const autoUnshelvedPRs = digest.autoUnshelvedPRs || [];
  const recentlyMerged = digest.recentlyMergedPRs || [];
  const shelvedUrls = new Set(shelvedPRs.map((pr) => pr.url));
  const activePRList = (digest.openPRs || []).filter((pr) => !shelvedUrls.has(pr.url));

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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OSS Autopilot - Mission Control</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.5.1" integrity="sha384-jb8JQMbMoBUzgWatfe6COACi2ljcDdZQ2OxczGA3bGNeWe+6DChMTBJemed7ZnvJ" crossorigin="anonymous"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>${DASHBOARD_CSS}
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
      <div class="header-controls">
        <div class="timestamp">
          Last updated: ${
            digest.generatedAt
              ? new Date(digest.generatedAt).toLocaleString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                  hour12: false,
                })
              : 'Unknown'
          }
        </div>
        <button class="theme-toggle" id="themeToggle" title="Toggle light/dark mode">
          <svg id="themeIconSun" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="5"/>
            <line x1="12" y1="1" x2="12" y2="3"/>
            <line x1="12" y1="21" x2="12" y2="23"/>
            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
            <line x1="1" y1="12" x2="3" y2="12"/>
            <line x1="21" y1="12" x2="23" y2="12"/>
            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
          </svg>
          <svg id="themeIconMoon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none;">
            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
          </svg>
          <span id="themeLabel">Light</span>
        </button>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card active">
        <div class="stat-value">${stats.activePRs}</div>
        <div class="stat-label">Active PRs</div>
      </div>
      <div class="stat-card shelved">
        <div class="stat-value">${stats.shelvedPRs}</div>
        <div class="stat-label">Shelved</div>
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
    </div>

    <div class="filter-toolbar" id="filterToolbar">
      <label>Filters</label>
      <input type="text" class="filter-search" id="searchInput" placeholder="Search by PR title..." />
      <select class="filter-select" id="statusFilter">
        <option value="all">All Statuses</option>
        <option value="needs-response">Needs Response</option>
        <option value="needs-changes">Needs Changes</option>
        <option value="ci-failing">CI Failing</option>
        <option value="conflict">Merge Conflict</option>
        <option value="changes-addressed">Changes Addressed</option>
        <option value="waiting-maintainer">Waiting on Maintainer</option>
        <option value="ci-blocked">CI Blocked</option>
        <option value="ci-not-running">CI Not Running</option>
        <option value="incomplete-checklist">Incomplete Checklist</option>
        <option value="missing-files">Missing Files</option>
        <option value="needs-rebase">Needs Rebase</option>
        <option value="shelved">Shelved</option>
        <option value="merged">Recently Merged</option>
        <option value="closed">Recently Closed</option>
        <option value="auto-unshelved">Auto-Unshelved</option>
        <option value="active">Active (No Issues)</option>
      </select>
      <select class="filter-select" id="repoFilter">
        <option value="all">All Repositories</option>
        ${(() => {
          const repos = new Set<string>();
          for (const pr of activePRList) repos.add(pr.repo);
          for (const pr of shelvedPRs) repos.add(pr.repo);
          for (const pr of actionRequired) repos.add(pr.repo);
          for (const pr of waitingOnOthers) repos.add(pr.repo);
          for (const pr of recentlyMerged) repos.add(pr.repo);
          for (const pr of digest.recentlyClosedPRs || []) repos.add(pr.repo);
          for (const pr of autoUnshelvedPRs) repos.add(pr.repo);
          return Array.from(repos)
            .sort()
            .map((repo) => `<option value="${escapeHtml(repo)}">${escapeHtml(repo)}</option>`)
            .join('\n        ');
        })()}
      </select>
      <span class="filter-count" id="filterCount"></span>
    </div>

    ${
      actionRequired.length > 0
        ? `
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
        ${renderHealthItems(
          digest.prsNeedingResponse || [],
          'needs-response',
          SVG_ICONS.comment,
          'Needs Response',
          (pr) =>
            pr.lastMaintainerComment
              ? `@${escapeHtml(pr.lastMaintainerComment.author)}: ${truncateTitle(pr.lastMaintainerComment.body, 40)}`
              : truncateTitle(pr.title),
        )}
        ${renderHealthItems(digest.needsChangesPRs || [], 'needs-changes', SVG_ICONS.edit, 'Needs Changes', titleMeta)}
        ${renderHealthItems(digest.ciFailingPRs || [], 'ci-failing', SVG_ICONS.xCircle, 'CI Failing', titleMeta)}
        ${renderHealthItems(digest.mergeConflictPRs || [], 'conflict', SVG_ICONS.conflict, 'Merge Conflict', titleMeta)}
        ${renderHealthItems(
          digest.incompleteChecklistPRs || [],
          'incomplete-checklist',
          SVG_ICONS.checklist,
          (pr) =>
            `Incomplete Checklist${pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : ''}`,
          titleMeta,
        )}
        ${renderHealthItems(
          digest.missingRequiredFilesPRs || [],
          'missing-files',
          SVG_ICONS.file,
          'Missing Required Files',
          (pr) => (pr.missingRequiredFiles ? escapeHtml(pr.missingRequiredFiles.join(', ')) : truncateTitle(pr.title)),
        )}
        ${renderHealthItems(
          digest.needsRebasePRs || [],
          'needs-rebase',
          SVG_ICONS.refresh,
          (pr) => `Needs Rebase${pr.commitsBehindUpstream ? ` (${pr.commitsBehindUpstream} behind)` : ''}`,
          titleMeta,
        )}
      </div>
    </section>
    `
        : ''
    }

    ${
      waitingOnOthers.length > 0
        ? `
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
        ${renderHealthItems(
          digest.changesAddressedPRs || [],
          'changes-addressed',
          SVG_ICONS.checkCircle,
          'Changes Addressed',
          (pr) =>
            `Awaiting re-review${pr.lastMaintainerComment ? ` from @${escapeHtml(pr.lastMaintainerComment.author)}` : ''}`,
        )}
        ${renderHealthItems(digest.waitingOnMaintainerPRs || [], 'waiting-maintainer', SVG_ICONS.clock, 'Waiting on Maintainer', titleMeta)}
        ${renderHealthItems(digest.ciBlockedPRs || [], 'ci-blocked', SVG_ICONS.lock, 'CI Blocked', titleMeta)}
        ${renderHealthItems(digest.ciNotRunningPRs || [], 'ci-not-running', SVG_ICONS.infoCircle, 'CI Not Running', titleMeta)}
      </div>
    </section>
    `
        : ''
    }

    ${
      actionRequired.length === 0 && waitingOnOthers.length === 0
        ? `
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
    `
        : ''
    }

    ${
      recentlyMerged.length > 0
        ? `
    <section class="health-section" style="animation-delay: 0.15s;">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-merged)" stroke-width="2">
          ${SVG_ICONS.gitMerge}
        </svg>
        <h2>Recently Merged</h2>
        <span class="health-badge" style="background: var(--accent-merged-dim); color: var(--accent-merged);">${recentlyMerged.length} merged</span>
      </div>
      <div class="health-items">
        ${recentlyMerged
          .map(
            (pr) => `
        <div class="health-item" style="border-left-color: var(--accent-merged);" data-status="merged" data-repo="${escapeHtml(pr.repo)}" data-title="${escapeHtml(pr.title.toLowerCase())}">
          <div class="health-icon" style="background: var(--accent-merged-dim); color: var(--accent-merged);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${SVG_ICONS.gitMerge}
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${escapeHtml(pr.url)}" target="_blank">${escapeHtml(pr.repo)}#${pr.number}</a> - Merged</div>
            <div class="health-meta">${truncateTitle(pr.title)}${pr.mergedAt ? ` · ${new Date(pr.mergedAt).toLocaleDateString()}` : ''}</div>
          </div>
        </div>
        `,
          )
          .join('')}
      </div>
    </section>
    `
        : ''
    }

    ${
      (digest.recentlyClosedPRs || []).length > 0
        ? `
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
        ${(digest.recentlyClosedPRs || [])
          .map(
            (pr) => `
        <div class="health-item" style="border-left-color: var(--text-muted); opacity: 0.7;" data-status="closed" data-repo="${escapeHtml(pr.repo)}" data-title="${escapeHtml(pr.title.toLowerCase())}">
          <div class="health-icon" style="background: rgba(110, 118, 129, 0.15); color: var(--text-muted);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="15" y1="9" x2="9" y2="15"/>
              <line x1="9" y1="9" x2="15" y2="15"/>
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${escapeHtml(pr.url)}" target="_blank">${escapeHtml(pr.repo)}#${pr.number}</a> - Closed</div>
            <div class="health-meta">${truncateTitle(pr.title)}${pr.closedAt ? ` · ${new Date(pr.closedAt).toLocaleDateString()}` : ''}</div>
          </div>
        </div>
        `,
          )
          .join('')}
      </div>
    </section>
    `
        : ''
    }

    ${
      autoUnshelvedPRs.length > 0
        ? `
    <section class="health-section" style="animation-delay: 0.25s;">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-info)" stroke-width="2">
          ${SVG_ICONS.bell}
        </svg>
        <h2>Auto-Unshelved</h2>
        <span class="health-badge" style="background: var(--accent-info-dim); color: var(--accent-info);">${autoUnshelvedPRs.length} unshelved</span>
      </div>
      <div class="health-items">
        ${renderHealthItems(
          autoUnshelvedPRs,
          'auto-unshelved',
          SVG_ICONS.bell,
          (pr) => 'Auto-Unshelved (' + pr.status.replace(/_/g, ' ') + ')',
          titleMeta,
        )}
      </div>
    </section>
    `
        : ''
    }

    ${
      issueResponses.length > 0
        ? `
    <section class="health-section" style="animation-delay: 0.3s;">
      <div class="health-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-info)" stroke-width="2">
          ${SVG_ICONS.comment}
        </svg>
        <h2>Issue Conversations</h2>
        <span class="health-badge" style="background: var(--accent-info-dim); color: var(--accent-info);">${issueResponses.length} repl${issueResponses.length !== 1 ? 'ies' : 'y'}</span>
      </div>
      <div class="health-items">
        ${issueResponses
          .map(
            (issue) => `
        <div class="health-item changes-addressed">
          <div class="health-icon" style="background: var(--accent-info-dim); color: var(--accent-info);">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${SVG_ICONS.comment}
            </svg>
          </div>
          <div class="health-content">
            <div class="health-title"><a href="${escapeHtml(issue.url)}" target="_blank">${escapeHtml(issue.repo)}#${issue.number}</a> - ${escapeHtml(issue.title.slice(0, 50))}${issue.title.length > 50 ? '...' : ''}</div>
            <div class="health-meta">@${escapeHtml(issue.lastResponseAuthor)}: ${escapeHtml(issue.lastResponseBody.slice(0, 60))}${issue.lastResponseBody.length > 60 ? '...' : ''}</div>
          </div>
        </div>
        `,
          )
          .join('')}
      </div>
    </section>
    `
        : ''
    }

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


    ${
      activePRList.length > 0
        ? `
    <section class="pr-list-section">
      <div class="pr-list-header">
        <h2 class="pr-list-title">Active Pull Requests</h2>
        <span class="pr-count">${activePRList.length} open</span>
      </div>
      <div class="pr-list">
        ${activePRList
          .map((pr) => {
            const hasIssues =
              pr.ciStatus === 'failing' ||
              pr.hasMergeConflict ||
              (pr.hasUnrespondedComment && pr.status !== 'changes_addressed') ||
              pr.status === 'needs_changes';
            const isStale = pr.daysSinceActivity >= approachingDormantDays;
            const itemClass = hasIssues ? 'has-issues' : isStale ? 'stale' : '';

            const prStatus =
              pr.ciStatus === 'failing'
                ? 'ci-failing'
                : pr.hasMergeConflict
                  ? 'conflict'
                  : pr.hasUnrespondedComment && pr.status !== 'changes_addressed' && pr.status !== 'failing_ci'
                    ? 'needs-response'
                    : pr.status === 'needs_changes'
                      ? 'needs-changes'
                      : pr.status === 'changes_addressed'
                        ? 'changes-addressed'
                        : 'active';

            return `
        <div class="pr-item ${itemClass}" data-status="${prStatus}" data-repo="${escapeHtml(pr.repo)}" data-title="${escapeHtml(pr.title.toLowerCase())}">
          <div class="pr-status-indicator">
            ${
              hasIssues
                ? `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            `
                : `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="16" x2="12" y2="12"/>
              <line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
            `
            }
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
              ${pr.hasUnrespondedComment && pr.status !== 'changes_addressed' && pr.status !== 'failing_ci' ? '<span class="badge badge-needs-response">Needs Response</span>' : ''}
              ${pr.reviewDecision === 'changes_requested' ? '<span class="badge badge-changes-requested">Changes Requested</span>' : ''}
              ${isStale ? `<span class="badge badge-stale">${pr.daysSinceActivity}d inactive</span>` : ''}
            </div>
          </div>
          <div class="pr-activity">
            ${pr.daysSinceActivity === 0 ? 'Today' : pr.daysSinceActivity === 1 ? 'Yesterday' : pr.daysSinceActivity + 'd ago'}
          </div>
        </div>`;
          })
          .join('')}
      </div>
    </section>
    `
        : `
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
    `
    }

    ${
      shelvedPRs.length > 0
        ? `
    <section class="pr-list-section" style="margin-top: 1.25rem; opacity: 0.7;">
      <div class="pr-list-header">
        <h2 class="pr-list-title">Shelved Pull Requests</h2>
        <span class="pr-count" style="background: rgba(110, 118, 129, 0.15); color: var(--text-muted);">${shelvedPRs.length} shelved</span>
      </div>
      <div class="pr-list">
        ${shelvedPRs
          .map(
            (pr) => `
        <div class="pr-item" data-status="shelved" data-repo="${escapeHtml(pr.repo)}" data-title="${escapeHtml(pr.title.toLowerCase())}">
          <div class="pr-status-indicator" style="background: rgba(110, 118, 129, 0.1); color: var(--text-muted);">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              ${SVG_ICONS.box}
            </svg>
          </div>
          <div class="pr-content">
            <div class="pr-title-row">
              <a href="${escapeHtml(pr.url)}" target="_blank" class="pr-title">${escapeHtml(pr.title)}</a>
              <span class="pr-repo">${escapeHtml(pr.repo)}#${pr.number}</span>
            </div>
            <div class="pr-badges">
              <span class="badge badge-days">${pr.daysSinceActivity}d inactive</span>
            </div>
          </div>
          <div class="pr-activity">
            ${pr.daysSinceActivity === 0 ? 'Today' : pr.daysSinceActivity === 1 ? 'Yesterday' : pr.daysSinceActivity + 'd ago'}
          </div>
        </div>`,
          )
          .join('')}
      </div>
    </section>
    `
        : ''
    }

    <footer class="footer">
      <p>OSS Autopilot // Mission Control</p>
      <p style="margin-top: 0.25rem;">Dashboard generated: ${digest.generatedAt ? new Date(digest.generatedAt).toISOString() : 'Unknown'}</p>
    </footer>
  </div>

  <script>
${generateDashboardScripts(stats, monthlyMerged, monthlyClosed, monthlyOpened, digest, state)}
  </script>
</body>
</html>`;
}

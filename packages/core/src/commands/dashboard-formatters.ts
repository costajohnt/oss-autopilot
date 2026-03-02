/**
 * Dashboard data formatting helpers: escapeHtml, DashboardStats, and stats builder.
 */

import type { DailyDigest, AgentState } from '../core/types.js';

export interface DashboardStats {
  activePRs: number;
  shelvedPRs: number;
  mergedPRs: number;
  closedPRs: number;
  mergeRate: string;
}

/**
 * Escape HTML special characters to prevent XSS when interpolating
 * user-controlled content (e.g. PR titles, comment bodies, author names) into HTML.
 * Note: This escapes HTML entity characters only. It does not sanitize URL schemes
 * (e.g., javascript:) — callers placing values in href attributes should validate
 * the URL scheme if the source is untrusted. GitHub API URLs are trusted.
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildDashboardStats(digest: DailyDigest, state: Readonly<AgentState>): DashboardStats {
  const summary = digest.summary || {
    totalActivePRs: 0,
    totalMergedAllTime: 0,
    mergeRate: 0,
    totalNeedingAttention: 0,
  };
  return {
    activePRs: summary.totalActivePRs,
    shelvedPRs: (digest.shelvedPRs || []).length,
    mergedPRs: summary.totalMergedAllTime,
    closedPRs: Object.values(state.repoScores || {}).reduce((sum, s) => sum + (s.closedWithoutMergeCount || 0), 0),
    mergeRate: `${(summary.mergeRate ?? 0).toFixed(1)}%`,
  };
}

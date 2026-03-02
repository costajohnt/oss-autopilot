/**
 * Reusable HTML component generators for the dashboard:
 * SVG icons, truncateTitle, renderHealthItems, titleMeta.
 */

import type { FetchedPR } from '../core/types.js';
import { escapeHtml } from './dashboard-formatters.js';

/** SVG path constants for health item icons. */
export const SVG_ICONS = {
  comment: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  edit: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>',
  xCircle: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  conflict:
    '<path d="M8 3v3a2 2 0 0 1-2 2H3"/><path d="M21 8h-3a2 2 0 0 1-2-2V3"/><path d="M3 16h3a2 2 0 0 1 2 2v3"/><path d="M16 21v-3a2 2 0 0 1 2-2h3"/>',
  checklist: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/>',
  checkCircle: '<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  infoCircle:
    '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  refresh: '<polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  gitMerge:
    '<circle cx="7" cy="18" r="3"/><circle cx="7" cy="6" r="3"/><circle cx="17" cy="12" r="3"/><line x1="7" y1="9" x2="7" y2="15"/><path d="M7 9c0 4 10 3 10 3"/>',
};

export function truncateTitle(title: string, max: number = 50): string {
  const truncated = title.length <= max ? title : title.slice(0, max) + '...';
  return escapeHtml(truncated);
}

/**
 * Render health status items. labelFn output is automatically HTML-escaped.
 * metaFn output is injected raw — callers must ensure metaFn returns safe HTML
 * (use escapeHtml for any user-controlled content within metaFn).
 *
 * Accepts both full FetchedPR objects and lightweight ShelvedPRRef objects.
 */
export function renderHealthItems<T extends Pick<FetchedPR, 'repo' | 'title' | 'url' | 'number'>>(
  prs: T[],
  cssClass: string,
  svgPaths: string,
  labelFn: string | ((pr: T) => string),
  metaFn: (pr: T) => string,
): string {
  return prs
    .map((pr) => {
      const rawLabel = typeof labelFn === 'string' ? labelFn : labelFn(pr);
      const label = escapeHtml(rawLabel);
      return `
        <div class="health-item ${cssClass}" data-status="${cssClass}" data-repo="${escapeHtml(pr.repo)}" data-title="${escapeHtml(pr.title.toLowerCase())}">
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
    })
    .join('');
}

/** Default meta: truncated PR title (works for both FetchedPR and ShelvedPRRef). */
export function titleMeta(pr: Pick<FetchedPR, 'title'>): string {
  return truncateTitle(pr.title);
}

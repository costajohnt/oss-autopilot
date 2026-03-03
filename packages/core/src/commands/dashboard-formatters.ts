/**
 * Dashboard HTML formatting helpers.
 * Used by dashboard-templates.ts and dashboard-components.ts for static HTML generation.
 */

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

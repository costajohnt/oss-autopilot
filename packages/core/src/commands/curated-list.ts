/**
 * Shared line-matching helpers for the curated issue-list commands
 * (`list-move-tier`, `list-mark-done`). Both commands locate entries in the
 * same markdown file, so they must agree on what counts as an entry line
 * and on URL matching semantics — they had drifted on both (#1442).
 */

/** Top-level list entry — `- `, `* `, `+ `, or `1.` at the start (no leading whitespace). */
export const ENTRY_LINE_RE = /^[*+-]\s|^\d+\.\s/;

/** The entry's leading list marker, for stripping before inspecting the body. */
export const ENTRY_MARKER_RE = /^(?:[*+-]\s+|\d+\.\s+)/;

/**
 * Match the URL only when followed by a non-digit character (or end of
 * line). A bare `includes(issueUrl)` would match `issues/1` against a line
 * containing `issues/10`, so acting on issue 1 would also hit issues
 * 10/100/... (#1442).
 */
export function lineMentionsUrl(line: string, issueUrl: string): boolean {
  const idx = line.indexOf(issueUrl);
  if (idx === -1) return false;
  const next = line.charCodeAt(idx + issueUrl.length);
  // NaN (end of string) → boundary OK. Otherwise reject any digit
  // immediately after the URL so 'issues/1' doesn't match 'issues/10'.
  return Number.isNaN(next) || next < 48 /* '0' */ || next > 57; /* '9' */
}

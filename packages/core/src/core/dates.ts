/**
 * Date math + relative-time formatting helpers.
 * Extracted from utils.ts under #1116.
 */

/**
 * Calculates the number of whole days between two dates, clamped to zero.
 *
 * Returns `0` if `from` is after `to` — reversed ranges and clock-skew do not
 * produce negative values. Partial days are truncated (e.g., 1.9 days -> 1).
 *
 * @example
 * daysBetween(new Date('2024-01-01'), new Date('2024-01-10'))
 * // 9
 */
export function daysBetween(from: Date, to: Date = new Date()): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24)));
}

/**
 * Formats a timestamp as a human-readable relative time string.
 *
 * Returns minutes for < 1 hour, hours for < 1 day, days for < 30 days,
 * and a locale-formatted date string for anything older.
 *
 * @example
 * formatRelativeTime('2024-01-20T10:00:00Z')
 * // "5d ago" (if called on Jan 25)
 */
export function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return 'just now';
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

/**
 * Creates a descending date comparator function for use with `Array.prototype.sort()`.
 *
 * Items with `null` or `undefined` dates are treated as epoch (sorted last).
 *
 * @example
 * const prs = [{ createdAt: '2024-01-01' }, { createdAt: '2024-06-15' }];
 * prs.sort(byDateDescending(pr => pr.createdAt));
 * // [{ createdAt: '2024-06-15' }, { createdAt: '2024-01-01' }]
 */
export function byDateDescending<T>(getDate: (item: T) => string | number | null | undefined) {
  return (a: T, b: T): number => {
    const dateA = new Date(getDate(a) || 0).getTime();
    const dateB = new Date(getDate(b) || 0).getTime();
    return dateB - dateA;
  };
}

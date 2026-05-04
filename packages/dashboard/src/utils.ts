import type { FetchedPRStatus } from './types';

/** Strip brackets from core display labels, e.g. "[CI Failing]" → "CI Failing". */
export function stripBrackets(label: string): string {
  return label.replace(/^\[|\]$/g, '');
}

/** Map a display label to a pill color CSS class. */
export function pillColorClass(label: string): string {
  const text = stripBrackets(label).toLowerCase();
  switch (text) {
    case 'needs response':
    case 'needs changes':
    case 'ci failing':
    case 'merge conflict':
    case 'missing files':
    case 'needs addressing':
      return 'pill--red';
    case 'incomplete checklist':
    case 'ci not running':
    case 'needs rebase':
    case 'ci blocked':
    case 'stale ci failure':
      return 'pill--amber';
    case 'waiting on maintainer':
      return 'pill--blue';
    default:
      return 'pill--muted';
  }
}

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

export function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function statusColor(status: FetchedPRStatus | string): string {
  switch (status) {
    case 'needs_addressing':
      return 'var(--red)';
    case 'waiting_on_maintainer':
      return 'var(--blue)';
    default:
      return 'var(--text-muted)';
  }
}

export function ciStatusColor(status: string): string {
  switch (status) {
    case 'passing':
      return 'var(--green)';
    case 'failing':
      return 'var(--red)';
    case 'pending':
      return 'var(--amber)';
    default:
      return 'var(--text-muted)';
  }
}

export function formatStarCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k`;
  return String(count);
}

/** GitHub linguist colors for the most common languages. */
const LANGUAGE_COLORS: Record<string, string> = {
  TypeScript: '#3178c6',
  JavaScript: '#f1e05a',
  Python: '#3572A5',
  Rust: '#dea584',
  Go: '#00ADD8',
  Java: '#b07219',
  'C#': '#178600',
  C: '#555555',
  'C++': '#f34b7d',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Swift: '#F05138',
  Kotlin: '#A97BFF',
  Dart: '#00B4AB',
  Shell: '#89e051',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Lua: '#000080',
};

export function getLanguageColor(language: string | null | undefined): string {
  if (!language) return 'var(--text-muted)';
  return LANGUAGE_COLORS[language] ?? 'var(--text-muted)';
}

export function formatRelativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'Updated just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

export function refreshLabel(loading: boolean, refreshing: boolean): string {
  if (loading) return 'Refreshing...';
  if (refreshing) return 'Updating...';
  return 'Refresh';
}

import type { FetchedPRStatus } from './types';

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
      return 'var(--accent-error)';
    case 'waiting_on_maintainer':
      return 'var(--accent-info)';
    default:
      return 'var(--text-muted)';
  }
}

export function ciStatusColor(status: string): string {
  switch (status) {
    case 'passing':
      return 'var(--accent-open)';
    case 'failing':
      return 'var(--accent-error)';
    case 'pending':
      return 'var(--accent-warning)';
    default:
      return 'var(--text-muted)';
  }
}

export function formatStarCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
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

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

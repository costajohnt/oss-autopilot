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
    case 'needs_response':
    case 'needs_changes':
    case 'failing_ci':
    case 'merge_conflict':
    case 'missing_required_files':
    case 'needs_rebase':
    case 'incomplete_checklist':
      return 'var(--accent-error)';
    case 'waiting_on_maintainer':
    case 'ci_blocked':
    case 'ci_not_running':
    case 'waiting':
      return 'var(--accent-info)';
    case 'healthy':
      return 'var(--accent-open)';
    case 'approaching_dormant':
    case 'dormant':
      return 'var(--accent-warning)';
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

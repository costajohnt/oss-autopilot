import type { FetchedPRStatus } from '../types';

export interface Filters {
  status: string;
  repo: string;
  search: string;
}

interface FilterBarProps {
  filters: Filters;
  onFilterChange: (filters: Filters) => void;
  repos: string[];
  statuses: string[];
}

/** Map raw FetchedPRStatus values to human-readable labels. */
const STATUS_LABELS: Record<FetchedPRStatus, string> = {
  needs_response: 'Needs Response',
  failing_ci: 'Failing CI',
  ci_blocked: 'CI Blocked',
  ci_not_running: 'CI Not Running',
  merge_conflict: 'Merge Conflict',
  needs_rebase: 'Needs Rebase',
  missing_required_files: 'Missing Required Files',
  incomplete_checklist: 'Incomplete Checklist',
  needs_changes: 'Needs Changes',
  changes_addressed: 'Changes Addressed',
  waiting: 'Waiting',
  waiting_on_maintainer: 'Waiting on Maintainer',
  healthy: 'Healthy',
  approaching_dormant: 'Approaching Dormant',
  dormant: 'Dormant',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status as FetchedPRStatus] ?? status;
}

export function FilterBar({ filters, onFilterChange, repos, statuses }: FilterBarProps) {
  return (
    <div class="filter-bar">
      <select
        class="filter-select"
        value={filters.status}
        onChange={(e) =>
          onFilterChange({ ...filters, status: (e.target as HTMLSelectElement).value })
        }
      >
        <option value="all">All Statuses</option>
        {statuses.map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>

      <select
        class="filter-select"
        value={filters.repo}
        onChange={(e) =>
          onFilterChange({ ...filters, repo: (e.target as HTMLSelectElement).value })
        }
      >
        <option value="all">All Repos</option>
        {repos.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <input
        class="filter-input"
        type="text"
        placeholder="Search PRs..."
        value={filters.search}
        onInput={(e) =>
          onFilterChange({ ...filters, search: (e.target as HTMLInputElement).value })
        }
      />
    </div>
  );
}

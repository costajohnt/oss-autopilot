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
  totalCount?: number;
  filteredCount?: number;
}

/** Map raw FetchedPRStatus values to human-readable labels. */
const STATUS_LABELS: Record<FetchedPRStatus, string> = {
  needs_addressing: 'Needs Addressing',
  waiting_on_maintainer: 'Waiting on Maintainer',
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status as FetchedPRStatus] ?? status;
}

export function FilterBar({ filters, onFilterChange, repos, statuses, totalCount, filteredCount }: FilterBarProps) {
  return (
    <div class="filter-bar">
      <select
        class="filter-select"
        aria-label="Filter by status"
        value={filters.status}
        onChange={(e) => onFilterChange({ ...filters, status: (e.target as HTMLSelectElement).value })}
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
        aria-label="Filter by repository"
        value={filters.repo}
        onChange={(e) => onFilterChange({ ...filters, repo: (e.target as HTMLSelectElement).value })}
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
        aria-label="Search PRs"
        placeholder="Search PRs..."
        value={filters.search}
        onInput={(e) => onFilterChange({ ...filters, search: (e.target as HTMLInputElement).value })}
      />

      {totalCount != null && filteredCount != null && (
        <span class="filter-count">
          Showing {filteredCount} of {totalCount} PRs
        </span>
      )}
    </div>
  );
}

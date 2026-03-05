import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { FilterBar } from './filter-bar';
import type { Filters } from './filter-bar';

const defaultFilters: Filters = { status: 'all', repo: 'all', search: '' };

interface FilterBarOptions {
  filters?: Filters;
  onFilterChange?: (filters: Filters) => void;
  repos?: string[];
  statuses?: string[];
}

function renderFilterBar(options: FilterBarOptions = {}) {
  const { filters = defaultFilters, onFilterChange = vi.fn(), repos = [], statuses = [] } = options;

  return {
    onFilterChange,
    ...render(<FilterBar filters={filters} onFilterChange={onFilterChange} repos={repos} statuses={statuses} />),
  };
}

describe('FilterBar', () => {
  it('renders status select with options', () => {
    const { container } = renderFilterBar({
      repos: ['owner/repo'],
      statuses: ['needs_addressing', 'waiting_on_maintainer'],
    });

    const selects = container.querySelectorAll('.filter-select');
    expect(selects).toHaveLength(2);

    const statusSelect = selects[0] as HTMLSelectElement;
    expect(statusSelect.options).toHaveLength(3);
    expect(statusSelect.options[1].textContent).toBe('Needs Addressing');
    expect(statusSelect.options[2].textContent).toBe('Waiting on Maintainer');
  });

  it('renders repo select with options', () => {
    const { container } = renderFilterBar({
      repos: ['owner/repo-a', 'owner/repo-b'],
    });

    const selects = container.querySelectorAll('.filter-select');
    const repoSelect = selects[1] as HTMLSelectElement;
    expect(repoSelect.options).toHaveLength(3);
  });

  it('calls onFilterChange when status changes', () => {
    const { container, onFilterChange } = renderFilterBar({
      statuses: ['needs_addressing', 'waiting_on_maintainer'],
    });

    const statusSelect = container.querySelector('.filter-select') as HTMLSelectElement;
    fireEvent.change(statusSelect, { target: { value: 'needs_addressing' } });

    expect(onFilterChange).toHaveBeenCalledWith({ ...defaultFilters, status: 'needs_addressing' });
  });

  it('calls onFilterChange when search input changes', () => {
    const { container, onFilterChange } = renderFilterBar();

    const input = container.querySelector('.filter-input') as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'fix bug' } });

    expect(onFilterChange).toHaveBeenCalledWith({ ...defaultFilters, search: 'fix bug' });
  });
});

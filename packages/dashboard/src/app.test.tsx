import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { App } from './app';
import { makePR, makeDashboardData } from './test-helpers';
import type { DashboardData } from './types';

function mockFetchOk(data: DashboardData) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    }),
  );
}

function mockFetchError(status: number, body?: { error: string }) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      json: () => (body ? Promise.resolve(body) : Promise.reject(new Error('no body'))),
    }),
  );
}

describe('App', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    // Never resolve to keep it in loading state
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(() => {})));

    const { container } = render(<App />);
    expect(container.textContent).toContain('Loading dashboard data...');
  });

  it('shows error state with retry button on fetch failure', async () => {
    mockFetchError(500, { error: 'Internal Server Error' });

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.textContent).toContain('Failed to load dashboard data');
    });
    expect(container.textContent).toContain('Internal Server Error');
    expect(container.querySelector('.shell-retry')).toBeTruthy();
  });

  it('renders dashboard with stats when data loads', async () => {
    const data = makeDashboardData({
      stats: { activePRs: 3, shelvedPRs: 1, mergedPRs: 10, closedPRs: 2, mergeRate: '83.3%' },
    });
    mockFetchOk(data);

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });
    expect(container.textContent).toContain('3 active PRs');
    expect(container.textContent).toContain('83.3% merge rate');
  });

  describe('filtering', () => {
    const prs = [
      makePR({
        url: 'https://github.com/a/b/pull/1',
        repo: 'a/b',
        number: 1,
        title: 'Fix auth bug',
        status: 'needs_addressing',
        actionReason: 'failing_ci',
      }),
      makePR({
        url: 'https://github.com/a/b/pull/2',
        repo: 'a/b',
        number: 2,
        title: 'Add feature',
        status: 'waiting_on_maintainer',
      }),
      makePR({
        url: 'https://github.com/c/d/pull/3',
        repo: 'c/d',
        number: 3,
        title: 'Update docs',
        status: 'waiting_on_maintainer',
      }),
    ];

    const data = makeDashboardData({ activePRs: prs });

    beforeEach(() => {
      mockFetchOk(data);
    });

    it('shows all PRs with no filters', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(3);
    });

    it('filters by status', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      // Change status filter to 'waiting_on_maintainer'
      const statusSelect = container.querySelector('.filter-select') as HTMLSelectElement;
      fireEvent.change(statusSelect, { target: { value: 'waiting_on_maintainer' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(2); // "Add feature" and "Update docs"
    });

    it('filters by repo', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      // Change repo filter to 'c/d'
      const selects = container.querySelectorAll('.filter-select');
      const repoSelect = selects[1] as HTMLSelectElement;
      fireEvent.change(repoSelect, { target: { value: 'c/d' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Update docs');
    });

    it('filters by search text (case-insensitive)', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      const searchInput = container.querySelector('.filter-input') as HTMLInputElement;
      fireEvent.input(searchInput, { target: { value: 'AUTH' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Fix auth bug');
    });

    it('combines multiple filters', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      // Filter by status 'waiting_on_maintainer' AND repo 'a/b'
      const statusSelect = container.querySelector('.filter-select') as HTMLSelectElement;
      fireEvent.change(statusSelect, { target: { value: 'waiting_on_maintainer' } });

      const selects = container.querySelectorAll('.filter-select');
      const repoSelect = selects[1] as HTMLSelectElement;
      fireEvent.change(repoSelect, { target: { value: 'a/b' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Add feature');
    });
  });

  it('populates filter dropdowns from PR data', async () => {
    const prs = [
      makePR({ repo: 'x/y', status: 'waiting_on_maintainer' }),
      makePR({
        repo: 'a/b',
        status: 'needs_addressing',
        actionReason: 'failing_ci',
        url: 'https://github.com/a/b/pull/2',
      }),
    ];
    mockFetchOk(makeDashboardData({ activePRs: prs }));

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // Repo select should have 'All Repos' + 2 unique repos (sorted)
    const selects = container.querySelectorAll('.filter-select');
    const repoSelect = selects[1] as HTMLSelectElement;
    const repoOptions = [...repoSelect.options].map((o) => o.value);
    expect(repoOptions).toEqual(['all', 'a/b', 'x/y']);

    // Status select should have 'All Statuses' + 2 unique statuses (sorted)
    const statusSelect = selects[0] as HTMLSelectElement;
    const statusOptions = [...statusSelect.options].map((o) => o.value);
    expect(statusOptions).toEqual(['all', 'needs_addressing', 'waiting_on_maintainer']);
  });

  it('shows error banner with dismiss button when error coexists with data', async () => {
    const data = makeDashboardData();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(data) })
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Refresh failed' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // Trigger refresh which will fail
    const refreshBtn = container.querySelector('.refresh-btn') as HTMLButtonElement;
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(container.querySelector('.error-banner')).toBeTruthy();
    });
    expect(container.querySelector('.error-banner')?.textContent).toContain('Refresh failed');
    expect(container.querySelector('.error-banner-dismiss')).toBeTruthy();
  });
});

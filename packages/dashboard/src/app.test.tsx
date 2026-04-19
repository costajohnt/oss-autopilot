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
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    // Reset the URL so route-dependent tests start from "/" regardless of
    // what the previous test navigated to (preact-iso's LocationProvider
    // reads window.location which is shared across tests in the same file).
    window.history.replaceState(null, '', '/');
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
    expect(container.textContent).toContain('3 active');
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

    it('filters by search text matching repo name', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      const searchInput = container.querySelector('.filter-input') as HTMLInputElement;
      fireEvent.input(searchInput, { target: { value: 'c/d' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Update docs');
    });

    it('filters by search text matching PR number', async () => {
      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.dashboard')).toBeTruthy();
      });

      const searchInput = container.querySelector('.filter-input') as HTMLInputElement;
      fireEvent.input(searchInput, { target: { value: '2' } });

      const rows = container.querySelectorAll('.pr-row');
      expect(rows).toHaveLength(1);
      expect(rows[0].textContent).toContain('Add feature');
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

  it('renders theme toggle in header and clicking it toggles data-theme', async () => {
    mockFetchOk(makeDashboardData());

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // Theme toggle button should be present
    const toggle = container.querySelector('.theme-toggle') as HTMLButtonElement;
    expect(toggle).toBeTruthy();

    // Capture initial theme (may vary by environment)
    const initialTheme = document.documentElement.getAttribute('data-theme');
    expect(initialTheme).toMatch(/^(light|dark)$/);

    // Click to toggle — wait for Preact's async state update + effect
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).not.toBe(initialTheme);
    });
    const toggledTheme = document.documentElement.getAttribute('data-theme');
    expect(toggledTheme).toMatch(/^(light|dark)$/);

    // Click again to toggle back
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe(initialTheme);
    });
  });

  it('error banner has role="alert"', async () => {
    mockFetchOk(makeDashboardData());
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('.refresh-btn')).toBeTruthy();
    });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fail')));
    const refreshBtn = container.querySelector('.refresh-btn') as HTMLButtonElement;
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      const banner = container.querySelector('.error-banner');
      expect(banner?.getAttribute('role')).toBe('alert');
    });
  });

  it('renders a skip-to-main link', async () => {
    mockFetchOk(makeDashboardData());
    const { container } = render(<App />);
    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });
    expect(container.querySelector('.skip-link')).toBeTruthy();
    expect(container.querySelector('.skip-link')?.getAttribute('href')).toBe('#main-content');
    const mainContent = container.querySelector('#main-content');
    expect(mainContent).toBeTruthy();
  });

  it('shows error banner with dismiss button when error coexists with data', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const data = makeDashboardData();
    const fetchMock = vi
      .fn()
      // 1. Initial GET /api/data — success
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(data) })
      // 2. Auto-refresh POST /api/refresh — success (silent background refresh after 5s)
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(data) })
      // 3. Manual refresh POST /api/refresh — failure (triggered by button click)
      .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Refresh failed' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<App />);

    await waitFor(() => {
      expect(container.querySelector('.dashboard')).toBeTruthy();
    });

    // Advance past the 5s auto-refresh timer so mock #2 is consumed
    vi.advanceTimersByTime(5_000);

    // Wait for auto-refresh to complete before clicking manual refresh
    await waitFor(() => {
      const btn = container.querySelector('.refresh-btn') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      expect(btn.textContent).toBe('Refresh');
    });

    // Trigger refresh which will fail (consumes mock #3)
    const refreshBtn = container.querySelector('.refresh-btn') as HTMLButtonElement;
    fireEvent.click(refreshBtn);

    await waitFor(() => {
      expect(container.querySelector('.error-banner')).toBeTruthy();
    });
    expect(container.querySelector('.error-banner')?.textContent).toContain('Refresh failed');
    expect(container.querySelector('.error-banner-dismiss')).toBeTruthy();

    vi.useRealTimers();
  });

  // ── Action round-trips (#966) ─────────────────────────────────────
  //
  // These tests exercise the wiring between the ActionBar buttons in the
  // PR detail pane and the POST /api/action endpoint. The hooks are
  // covered by unit tests; this verifies the glue in app.tsx that routes
  // the performAction callback through PRDetail -> ActionBar.

  describe('action round-trips', () => {
    it('shelve button fires POST /api/action with the right payload and re-renders', async () => {
      const pr = makePR({ url: 'https://github.com/owner/repo/pull/42', number: 42, title: 'Fix it' });
      const initial = makeDashboardData({ activePRs: [pr] });
      const afterShelve = makeDashboardData({ activePRs: [pr], shelvedPRUrls: [pr.url] });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(initial) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(afterShelve) });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());

      fireEvent.click(container.querySelector('.pr-row') as HTMLElement);
      await waitFor(() => expect(container.querySelector('.action-btn--shelve')).toBeTruthy());
      fireEvent.click(container.querySelector('.action-btn--shelve') as HTMLButtonElement);

      await waitFor(() => {
        const actionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/action');
        expect(actionCall).toBeDefined();
      });
      const actionCall = fetchMock.mock.calls.find((c) => c[0] === '/api/action')!;
      expect(actionCall[1].method).toBe('POST');
      expect(JSON.parse(actionCall[1].body as string)).toEqual({
        action: 'move',
        url: pr.url,
        target: 'shelved',
      });

      await waitFor(() => expect(container.querySelector('.action-btn--unshelve')).toBeTruthy());
    });

    it('status override button (Move to Waiting) fires the correct target', async () => {
      const pr = makePR({
        url: 'https://github.com/owner/repo/pull/7',
        number: 7,
        status: 'needs_addressing',
      });
      const initial = makeDashboardData({ activePRs: [pr] });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(initial) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(initial) });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());

      fireEvent.click(container.querySelector('.pr-row') as HTMLElement);
      await waitFor(() => expect(container.querySelector('.action-btn--override')).toBeTruthy());
      fireEvent.click(container.querySelector('.action-btn--override') as HTMLButtonElement);

      await waitFor(() => {
        const call = fetchMock.mock.calls.find((c) => c[0] === '/api/action');
        expect(call).toBeDefined();
        expect(JSON.parse(call![1].body as string)).toMatchObject({
          action: 'move',
          url: pr.url,
          target: 'waiting',
        });
      });
    });

    it('surfaces action error to the user without crashing', async () => {
      const pr = makePR();
      const initial = makeDashboardData({ activePRs: [pr] });

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(initial) })
        .mockResolvedValueOnce({ ok: false, status: 500, json: () => Promise.resolve({ error: 'Boom' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(initial) });
      vi.stubGlobal('fetch', fetchMock);

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());

      fireEvent.click(container.querySelector('.pr-row') as HTMLElement);
      await waitFor(() => expect(container.querySelector('.action-btn--shelve')).toBeTruthy());
      fireEvent.click(container.querySelector('.action-btn--shelve') as HTMLButtonElement);

      await waitFor(() => {
        expect(container.querySelector('.action-error')).toBeTruthy();
      });
      expect(container.querySelector('.action-error')?.textContent).toContain('Boom');
    });
  });

  // ── Celebration toast (#966) ──────────────────────────────────────
  //
  // The celebration hook is unit-tested, but the wiring through app.tsx
  // where the data fetch's mergedPRs count is passed to useCelebration
  // was not covered.

  describe('celebration toast integration', () => {
    it('shows a celebration toast when mergedPRs jumps above the stored count', async () => {
      localStorage.setItem('oss-autopilot-merged-count', '5');

      const data = makeDashboardData({
        stats: { activePRs: 0, shelvedPRs: 0, mergedPRs: 7, closedPRs: 0, mergeRate: '100%' },
      });
      mockFetchOk(data);

      const { container } = render(<App />);

      await waitFor(() => {
        expect(container.querySelector('.celebration-toast')).toBeTruthy();
      });
      expect(container.querySelector('.celebration-toast')?.textContent).toContain('2 new PRs merged');
    });

    it('does not show a toast when mergedPRs matches the stored count', async () => {
      localStorage.setItem('oss-autopilot-merged-count', '5');

      const data = makeDashboardData({
        stats: { activePRs: 0, shelvedPRs: 0, mergedPRs: 5, closedPRs: 0, mergeRate: '100%' },
      });
      mockFetchOk(data);

      const { container } = render(<App />);

      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());
      await new Promise((r) => setTimeout(r, 50));

      expect(container.querySelector('.celebration-toast')).toBeFalsy();
    });
  });

  // ── Route navigation (#966) ───────────────────────────────────────

  describe('route navigation', () => {
    it('clicking the Merged PRs stat pill navigates to /merged and renders MergedPRList', async () => {
      const data = makeDashboardData({
        stats: { activePRs: 0, shelvedPRs: 0, mergedPRs: 3, closedPRs: 0, mergeRate: '100%' },
        allMergedPRs: [
          {
            url: 'https://github.com/o/r/pull/1',
            repo: 'o/r',
            number: 1,
            title: 'Merged A',
            mergedAt: '2026-01-01T00:00:00Z',
          },
        ],
      });
      mockFetchOk(data);

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());

      const mergedButton = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Merged PRs'),
      );
      expect(mergedButton).toBeTruthy();
      fireEvent.click(mergedButton!);

      await waitFor(() => {
        expect(container.textContent).toContain('Merged A');
      });
    });

    it('clicking the Closed PRs stat pill navigates to /closed and renders ClosedPRList', async () => {
      const data = makeDashboardData({
        stats: { activePRs: 0, shelvedPRs: 0, mergedPRs: 0, closedPRs: 2, mergeRate: '0%' },
        allClosedPRs: [
          {
            url: 'https://github.com/o/r/pull/5',
            repo: 'o/r',
            number: 5,
            title: 'Closed X',
            closedAt: '2026-01-05T00:00:00Z',
          },
        ],
      });
      mockFetchOk(data);

      const { container } = render(<App />);
      await waitFor(() => expect(container.querySelector('.dashboard')).toBeTruthy());

      const closedButton = Array.from(container.querySelectorAll('button')).find((b) =>
        b.textContent?.includes('Closed PRs'),
      );
      expect(closedButton).toBeTruthy();
      fireEvent.click(closedButton!);

      await waitFor(() => {
        expect(container.textContent).toContain('Closed X');
      });
    });
  });
});

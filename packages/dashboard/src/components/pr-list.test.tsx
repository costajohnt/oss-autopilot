import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { PRList, statusClass } from './pr-list';
import { makePR } from '../test-helpers';
import type { FetchedPR, FetchedPRStatus } from '../types';

interface PRListOptions {
  prs?: FetchedPR[];
  selectedUrl?: string | null;
  onSelect?: (url: string) => void;
  shelvedUrls?: Set<string>;
}

function renderPRList(options: PRListOptions = {}) {
  const { prs = [], selectedUrl = null, onSelect = vi.fn(), shelvedUrls = new Set<string>() } = options;

  return render(<PRList prs={prs} selectedUrl={selectedUrl} onSelect={onSelect} shelvedUrls={shelvedUrls} />);
}

describe('PRList', () => {
  it('renders "No PRs to display" when empty', () => {
    const { container } = renderPRList();
    expect(container.textContent).toContain('No PRs to display');
  });

  it('groups PRs into sections by status', () => {
    const prs = [
      makePR({
        url: 'https://github.com/o/r/pull/1',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        number: 1,
      }),
      makePR({ url: 'https://github.com/o/r/pull/2', status: 'waiting_on_maintainer', number: 2 }),
    ];

    const { container } = renderPRList({ prs });

    const sections = container.querySelectorAll('.pr-section-header');
    const sectionTitles = [...sections].map((el) => el.textContent?.replace(/\d+$/, '').trim());
    expect(sectionTitles).toContain('Need Attention');
    expect(sectionTitles).toContain('Waiting on Others');
  });

  it('excludes shelved PRs from active sections', () => {
    const prs = [
      makePR({ url: 'https://github.com/o/r/pull/1', status: 'waiting_on_maintainer', number: 1 }),
      makePR({ url: 'https://github.com/o/r/pull/2', status: 'waiting_on_maintainer', number: 2 }),
    ];

    const { container } = renderPRList({
      prs,
      shelvedUrls: new Set(['https://github.com/o/r/pull/2']),
    });

    const rows = container.querySelectorAll('.pr-row');
    expect(rows).toHaveLength(1);
  });

  it('PR rows are keyboard-accessible', () => {
    const onSelect = vi.fn();
    const prs = [makePR({ url: 'https://github.com/o/r/pull/1', status: 'needs_addressing', number: 1 })];
    const { container } = renderPRList({ prs, onSelect });
    const row = container.querySelector('.pr-row');
    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row!, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('PR rows respond to Space key', () => {
    const onSelect = vi.fn();
    const prs = [makePR({ url: 'https://github.com/o/r/pull/1', status: 'needs_addressing', number: 1 })];
    const { container } = renderPRList({ prs, onSelect });
    const row = container.querySelector('.pr-row');
    fireEvent.keyDown(row!, { key: ' ' });
    expect(onSelect).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('calls onSelect when a PR row is clicked', () => {
    const onSelect = vi.fn();
    const prs = [makePR({ url: 'https://github.com/o/r/pull/1', status: 'waiting_on_maintainer' })];

    const { container } = renderPRList({ prs, onSelect });

    const row = container.querySelector('.pr-row') as HTMLElement;
    fireEvent.click(row);

    expect(onSelect).toHaveBeenCalledWith('https://github.com/o/r/pull/1');
  });

  it('highlights the selected PR row', () => {
    const prs = [makePR({ url: 'https://github.com/o/r/pull/1', status: 'waiting_on_maintainer' })];

    const { container } = renderPRList({
      prs,
      selectedUrl: 'https://github.com/o/r/pull/1',
    });

    const row = container.querySelector('.pr-row');
    expect(row?.classList.contains('pr-row--selected')).toBe(true);
  });

  it('shows shelved section with correct count', () => {
    const prs = [
      makePR({ url: 'https://github.com/o/r/pull/1', status: 'waiting_on_maintainer', number: 1 }),
      makePR({ url: 'https://github.com/o/r/pull/2', status: 'waiting_on_maintainer', number: 2 }),
    ];

    const { container } = renderPRList({
      prs,
      shelvedUrls: new Set(['https://github.com/o/r/pull/2']),
    });

    const shelvedHeader = [...container.querySelectorAll('.pr-section-header')].find((el) =>
      el.textContent?.includes('Shelved'),
    );
    expect(shelvedHeader).toBeTruthy();
    expect(shelvedHeader?.querySelector('.pr-section-count')?.textContent).toBe('1');
  });

  it('sets aria-expanded on shelved section toggle', () => {
    const prs = [makePR({ url: 'https://github.com/o/r/pull/1', status: 'needs_addressing' })];
    const shelvedUrls = new Set(['https://github.com/o/r/pull/1']);
    const { container } = renderPRList({ prs, shelvedUrls });
    const header = container.querySelector('.pr-section-header--collapsible');
    expect(header?.getAttribute('aria-expanded')).toBe('false');
    expect(header?.getAttribute('aria-controls')).toBe('shelved-pr-list');
    fireEvent.click(header!);
    expect(header?.getAttribute('aria-expanded')).toBe('true');
  });

  it('displays PR title, repo#number, and activity age', () => {
    const prs = [
      makePR({
        url: 'https://github.com/o/r/pull/42',
        repo: 'o/r',
        number: 42,
        title: 'Fix critical bug',
        daysSinceActivity: 3,
        status: 'waiting_on_maintainer',
      }),
    ];

    const { container } = renderPRList({ prs });

    expect(container.textContent).toContain('o/r#42');
    expect(container.textContent).toContain('Fix critical bug');
    expect(container.textContent).toContain('3d');
  });

  it('applies status-aware CSS class to PR rows', () => {
    const prs = [
      makePR({
        url: 'https://github.com/o/r/pull/1',
        status: 'needs_addressing',
        actionReason: 'needs_response',
        number: 1,
      }),
      makePR({ url: 'https://github.com/o/r/pull/2', status: 'waiting_on_maintainer', number: 2 }),
    ];

    const { container } = renderPRList({ prs });

    const rows = container.querySelectorAll('.pr-row');
    expect(rows[0]?.classList.contains('pr-row--need-attention')).toBe(true);
    expect(rows[1]?.classList.contains('pr-row--waiting')).toBe(true);
  });
});

describe('statusClass', () => {
  it('returns pr-row--need-attention for needs_addressing', () => {
    expect(statusClass('needs_addressing')).toBe('pr-row--need-attention');
  });

  it('returns pr-row--waiting for waiting_on_maintainer', () => {
    expect(statusClass('waiting_on_maintainer')).toBe('pr-row--waiting');
  });

  it('returns empty string for unknown status', () => {
    // Cast to bypass compile-time exhaustive check
    expect(statusClass('unknown_status' as FetchedPRStatus)).toBe('');
  });
});

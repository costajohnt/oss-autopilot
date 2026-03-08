import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { PRList } from './pr-list';
import { makePR } from '../test-helpers';
import type { FetchedPR } from '../types';

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
});

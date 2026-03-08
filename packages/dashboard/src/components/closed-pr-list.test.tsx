import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { ClosedPRList } from './closed-pr-list';
import { makeClosedPR } from '../test-helpers';

describe('ClosedPRList', () => {
  const prs = [
    makeClosedPR({
      url: 'https://github.com/a/b/pull/1',
      repo: 'a/b',
      number: 1,
      title: 'First PR',
      closedAt: '2025-06-10T00:00:00Z',
    }),
    makeClosedPR({
      url: 'https://github.com/c/d/pull/2',
      repo: 'c/d',
      number: 2,
      title: 'Second PR',
      closedAt: '2025-06-09T00:00:00Z',
    }),
  ];

  it('renders back button that calls onBack', () => {
    const onBack = vi.fn();
    const { container } = render(<ClosedPRList closedPRs={prs} onBack={onBack} />);
    const backBtn = container.querySelector('.merged-view-back') as HTMLButtonElement;
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn);
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('renders all PRs with titles and GitHub links', () => {
    const { container } = render(<ClosedPRList closedPRs={prs} onBack={() => {}} />);
    const links = container.querySelectorAll('.recent-activity-link');
    expect(links).toHaveLength(2);
    expect((links[0] as HTMLAnchorElement).href).toBe('https://github.com/a/b/pull/1');
    expect((links[0] as HTMLAnchorElement).target).toBe('_blank');
    expect((links[0] as HTMLAnchorElement).rel).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe('a/b#1');
    expect(links[1].textContent).toBe('c/d#2');
  });

  it('shows formatted close dates', () => {
    const { container } = render(<ClosedPRList closedPRs={prs} onBack={() => {}} />);
    const dates = container.querySelectorAll('.recent-activity-date');
    expect(dates).toHaveLength(2);
    // Just check they render (formatting depends on locale)
    expect(dates[0].textContent).toBeTruthy();
  });

  it('shows count in subtitle', () => {
    const { container } = render(<ClosedPRList closedPRs={prs} onBack={() => {}} />);
    const subtitle = container.querySelector('.merged-view-subtitle');
    expect(subtitle?.textContent).toBe('2 total');
  });

  it('shows empty state when no PRs', () => {
    const { container } = render(<ClosedPRList closedPRs={[]} onBack={() => {}} />);
    const empty = container.querySelector('.merged-view-empty');
    expect(empty).toBeTruthy();
    expect(empty?.textContent).toContain('No closed PRs found');
  });

  it('shows Closed badge for each PR', () => {
    const { container } = render(<ClosedPRList closedPRs={prs} onBack={() => {}} />);
    const badges = container.querySelectorAll('.recent-activity-badge--closed');
    expect(badges).toHaveLength(2);
    expect(badges[0].textContent).toBe('Closed');
  });
});

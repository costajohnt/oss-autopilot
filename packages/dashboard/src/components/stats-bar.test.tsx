import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { StatsBar } from './stats-bar';

describe('StatsBar', () => {
  const stats = { activePRs: 5, shelvedPRs: 2, mergedPRs: 10, closedPRs: 3, mergeRate: '76.9%' };
  const baseProps = { stats, needAttentionCount: 3, waitingCount: 2 };

  it('renders all stat cards', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    const cards = container.querySelectorAll('.stat-card');
    expect(cards).toHaveLength(5);
  });

  it('displays correct values', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    const values = [...container.querySelectorAll('.stat-value')].map((el) => el.textContent);
    expect(values).toEqual(['3', '2', '2', '10', '3']);
  });

  it('displays correct labels', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    const labels = [...container.querySelectorAll('.stat-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Need Attention', 'Waiting on Others', 'Shelved', 'Merged PRs', 'Closed PRs']);
  });

  it('renders need attention card as clickable when handler provided', () => {
    const onClick = vi.fn();
    const { container } = render(<StatsBar {...baseProps} onNeedAttentionClick={onClick} />);
    const clickable = container.querySelectorAll('.stat-card--clickable');
    expect(clickable.length).toBeGreaterThanOrEqual(1);
    const attentionBtn = [...clickable].find((el) => el.querySelector('.stat-label')?.textContent === 'Need Attention');
    expect(attentionBtn?.tagName).toBe('BUTTON');
  });

  it('calls onMergedClick when merged card is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<StatsBar {...baseProps} onMergedClick={onClick} />);
    const clickable = [...container.querySelectorAll('.stat-card--clickable')].find(
      (el) => el.querySelector('.stat-label')?.textContent === 'Merged PRs',
    ) as HTMLButtonElement;
    fireEvent.click(clickable);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders cards as divs when no click handlers provided', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    const clickable = container.querySelectorAll('.stat-card--clickable');
    expect(clickable).toHaveLength(0);
  });

  it('calls onClosedClick when closed card is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<StatsBar {...baseProps} onClosedClick={onClick} />);
    const clickable = [...container.querySelectorAll('.stat-card--clickable')].find(
      (el) => el.querySelector('.stat-label')?.textContent === 'Closed PRs',
    ) as HTMLButtonElement;
    fireEvent.click(clickable);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders multiple clickable cards when multiple handlers provided', () => {
    const onMerged = vi.fn();
    const onClosed = vi.fn();
    const onAttention = vi.fn();
    const { container } = render(
      <StatsBar {...baseProps} onMergedClick={onMerged} onClosedClick={onClosed} onNeedAttentionClick={onAttention} />,
    );
    const clickable = container.querySelectorAll('.stat-card--clickable');
    expect(clickable.length).toBeGreaterThanOrEqual(3);
  });
});

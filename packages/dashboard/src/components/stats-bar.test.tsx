import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/preact';
import { StatsBar } from './stats-bar';

describe('StatsBar', () => {
  const stats = { activePRs: 5, shelvedPRs: 2, mergedPRs: 10, closedPRs: 3, mergeRate: '76.9%' };
  const baseProps = { stats, needAttentionCount: 3, waitingCount: 2 };

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders all stat cards', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    const cards = container.querySelectorAll('.stat-card');
    expect(cards).toHaveLength(5);
  });

  it('renders Stuck CI and Dormant Follow-up cards only when non-zero (#1352)', () => {
    const { container } = render(<StatsBar {...baseProps} stuckCICount={2} dormantFollowupCount={1} />);
    const labels = [...container.querySelectorAll('.stat-label')].map((el) => el.textContent);
    expect(labels).toContain('Stuck CI');
    expect(labels).toContain('Dormant Follow-up');
    // Inserted between Need Attention and Waiting on Others
    expect(labels.indexOf('Stuck CI')).toBeGreaterThan(labels.indexOf('Need Attention'));
    expect(labels.indexOf('Dormant Follow-up')).toBeLessThan(labels.indexOf('Waiting on Others'));
  });

  it('fires the bucket click handlers (#1352)', () => {
    const onStuckCIClick = vi.fn();
    const onDormantFollowupClick = vi.fn();
    const { getByText } = render(
      <StatsBar
        {...baseProps}
        stuckCICount={1}
        dormantFollowupCount={1}
        onStuckCIClick={onStuckCIClick}
        onDormantFollowupClick={onDormantFollowupClick}
      />,
    );
    fireEvent.click(getByText('Stuck CI'));
    fireEvent.click(getByText('Dormant Follow-up'));
    expect(onStuckCIClick).toHaveBeenCalledOnce();
    expect(onDormantFollowupClick).toHaveBeenCalledOnce();
  });

  it('displays correct values after animation', () => {
    const { container } = render(<StatsBar {...baseProps} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
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

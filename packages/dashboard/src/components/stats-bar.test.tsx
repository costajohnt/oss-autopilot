import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { StatsBar } from './stats-bar';

describe('StatsBar', () => {
  const stats = { activePRs: 5, shelvedPRs: 2, mergedPRs: 10, closedPRs: 3, mergeRate: '76.9%' };

  it('renders all stat cards', () => {
    const { container } = render(<StatsBar stats={stats} />);
    const cards = container.querySelectorAll('.stat-card');
    expect(cards).toHaveLength(5);
  });

  it('displays correct values', () => {
    const { container } = render(<StatsBar stats={stats} />);
    const values = [...container.querySelectorAll('.stat-value')].map((el) => el.textContent);
    expect(values).toEqual(['5', '2', '10', '3', '76.9%']);
  });

  it('displays correct labels', () => {
    const { container } = render(<StatsBar stats={stats} />);
    const labels = [...container.querySelectorAll('.stat-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Active PRs', 'Shelved PRs', 'Merged PRs', 'Closed PRs', 'Merge Rate']);
  });

  it('renders merged card as clickable button when onMergedClick provided', () => {
    const onClick = vi.fn();
    const { container } = render(<StatsBar stats={stats} onMergedClick={onClick} />);
    const clickable = container.querySelectorAll('.stat-card--clickable');
    expect(clickable).toHaveLength(1);
    expect(clickable[0].tagName).toBe('BUTTON');
    expect(clickable[0].querySelector('.stat-label')?.textContent).toBe('Merged PRs');
  });

  it('calls onMergedClick when merged card is clicked', () => {
    const onClick = vi.fn();
    const { container } = render(<StatsBar stats={stats} onMergedClick={onClick} />);
    const clickable = container.querySelector('.stat-card--clickable') as HTMLButtonElement;
    fireEvent.click(clickable);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders all cards as divs when onMergedClick not provided', () => {
    const { container } = render(<StatsBar stats={stats} />);
    const clickable = container.querySelectorAll('.stat-card--clickable');
    expect(clickable).toHaveLength(0);
    const buttons = container.querySelectorAll('button');
    expect(buttons).toHaveLength(0);
  });
});

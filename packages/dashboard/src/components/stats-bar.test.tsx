import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
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
});

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { RecentActivity } from './recent-activity';
import { makeMergedPR, makeClosedPR, makeShelvedRef } from '../test-helpers';

describe('RecentActivity', () => {
  it('returns null when all arrays are empty', () => {
    const { container } = render(<RecentActivity mergedPRs={[]} closedPRs={[]} autoUnshelvedPRs={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders merged PR section', () => {
    const merged = [makeMergedPR({ title: 'Add feature X' })];

    const { container } = render(<RecentActivity mergedPRs={merged} closedPRs={[]} autoUnshelvedPRs={[]} />);

    expect(container.textContent).toContain('Merged (1)');
    expect(container.textContent).toContain('Add feature X');
    expect(container.querySelector('.recent-activity-badge--merged')?.textContent).toBe('Merged');
  });

  it('renders closed PR section', () => {
    const closed = [makeClosedPR({ title: 'Stale PR', closedBy: 'maintainer' })];

    const { container } = render(<RecentActivity mergedPRs={[]} closedPRs={closed} autoUnshelvedPRs={[]} />);

    expect(container.textContent).toContain('Closed (1)');
    expect(container.textContent).toContain('Stale PR');
  });

  it('renders auto-unshelved PR section', () => {
    const unshelved = [makeShelvedRef({ title: 'Revived PR', number: 42 })];

    const { container } = render(<RecentActivity mergedPRs={[]} closedPRs={[]} autoUnshelvedPRs={unshelved} />);

    expect(container.textContent).toContain('Auto-Unshelved (1)');
    expect(container.textContent).toContain('Revived PR');
  });

  it('renders multiple sections together', () => {
    const merged = [makeMergedPR()];
    const closed = [makeClosedPR()];
    const unshelved = [makeShelvedRef()];

    const { container } = render(
      <RecentActivity mergedPRs={merged} closedPRs={closed} autoUnshelvedPRs={unshelved} />,
    );

    expect(container.querySelectorAll('.recent-activity-section')).toHaveLength(3);
  });
});

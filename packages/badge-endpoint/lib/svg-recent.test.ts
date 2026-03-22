import { describe, it, expect } from 'vitest';
import { renderRecentCard } from './svg-recent.js';
import type { ContributionData } from './github-data.js';

const sampleData: ContributionData = {
  merged: 42,
  open: 3,
  closedUnmerged: 5,
  mergeRate: 84,
  repoCount: 12,
  recentPRs: [
    {
      number: 101,
      title: 'Fix critical bug in authentication module',
      url: 'https://github.com/owner/repo-one/pull/101',
      repo: 'owner/repo-one',
      mergedAt: '2026-03-20T10:00:00Z',
    },
    {
      number: 202,
      title: 'Add new feature for dashboard widgets',
      url: 'https://github.com/owner/repo-two/pull/202',
      repo: 'owner/repo-two',
      mergedAt: '2026-03-19T08:00:00Z',
    },
    {
      number: 303,
      title: 'Refactor data pipeline for better performance and throughput improvements',
      url: 'https://github.com/owner/repo-three/pull/303',
      repo: 'owner/repo-three',
      mergedAt: '2026-03-18T06:00:00Z',
    },
  ],
  cappedMerged: false,
  cappedClosedUnmerged: false,
  dailyActivity: { '2026-03-20': 1, '2026-03-19': 1, '2026-03-18': 1 },
  streak: 3,
};

const emptyData: ContributionData = {
  ...sampleData,
  recentPRs: [],
};

describe('renderRecentCard', () => {
  it('produces valid SVG with correct dimensions', () => {
    const svg = renderRecentCard(sampleData, 'light');
    expect(svg).toContain('width="495"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('displays repo names', () => {
    const svg = renderRecentCard(sampleData, 'light');
    expect(svg).toContain('repo-one');
    expect(svg).toContain('repo-two');
    expect(svg).toContain('repo-three');
  });

  it('renders color-coded bars for each PR', () => {
    const svg = renderRecentCard(sampleData, 'light');
    // Each PR row has a colored rect bar; check there are rect elements with fill colors
    expect(svg).toContain('<rect');
    // REPO_COLORS[0] is #e11d48
    expect(svg).toContain('#e11d48');
  });

  it('truncates long PR titles to 40 chars', () => {
    const svg = renderRecentCard(sampleData, 'light');
    // truncate(str, 40) → str.slice(0, 39) + '…'
    expect(svg).toContain('Refactor data pipeline for better perfo');
    // The full long title should not appear untruncated
    expect(svg).not.toContain('performance and throughput improvements');
  });

  it('shows "No recent contributions" when PR list is empty', () => {
    const svg = renderRecentCard(emptyData, 'light');
    expect(svg).toContain('No recent contributions');
  });

  it('renders dark theme', () => {
    const svg = renderRecentCard(sampleData, 'dark');
    expect(svg).toContain('#0d1117');
  });

  it('includes the crystal icon', () => {
    const svg = renderRecentCard(sampleData, 'light');
    expect(svg).toContain('url(#a1)');
  });

  it('includes time ago text for each PR', () => {
    const svg = renderRecentCard(sampleData, 'light');
    // mergedAt dates are in 2026-03 and today is 2026-03-21, so "1 day ago" etc.
    expect(svg).toMatch(/ago/);
  });
});

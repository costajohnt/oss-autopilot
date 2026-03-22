import { describe, it, expect } from 'vitest';
import { renderStatsCard } from './svg-card.js';
import type { ContributionData } from './github-data.js';

const sampleData: ContributionData = {
  merged: 42,
  open: 3,
  closedUnmerged: 5,
  mergeRate: 84,
  repoCount: 12,
  recentPRs: [],
  cappedMerged: false,
  cappedClosedUnmerged: false,
  dailyActivity: { '2026-03-01': 2, '2026-03-08': 1, '2026-03-15': 3 },
  streak: 3,
};

describe('renderStatsCard', () => {
  it('produces valid SVG with correct dimensions', () => {
    const svg = renderStatsCard(sampleData, 'light');
    expect(svg).toContain('width="495"');
    expect(svg).toContain('height="195"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });
  it('displays all four metrics', () => {
    const svg = renderStatsCard(sampleData, 'light');
    expect(svg).toContain('42');
    expect(svg).toContain('12');
    expect(svg).toContain('84%');
    expect(svg).toContain('3 weeks');
  });
  it('shows 1000+ when merged count is capped', () => {
    const capped = { ...sampleData, merged: 1500, cappedMerged: true };
    const svg = renderStatsCard(capped, 'light');
    expect(svg).toContain('1500+');
  });
  it('renders dark theme', () => {
    const svg = renderStatsCard(sampleData, 'dark');
    expect(svg).toContain('#0d1117');
  });
  it('includes the crystal icon', () => {
    const svg = renderStatsCard(sampleData, 'light');
    expect(svg).toContain('url(#a1)');
  });
  it('includes the OSS Autopilot title', () => {
    const svg = renderStatsCard(sampleData, 'light');
    expect(svg).toContain('OSS Autopilot');
  });
  it('includes a sparkline', () => {
    const svg = renderStatsCard(sampleData, 'light');
    expect(svg).toContain('<polyline');
  });
});

import { describe, it, expect } from 'vitest';
import { renderActivityGraph } from './svg-activity.js';
import type { ContributionData } from './github-data.js';

function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

const sampleData: ContributionData = {
  merged: 42,
  open: 3,
  closedUnmerged: 5,
  mergeRate: 89.4,
  repoCount: 12,
  recentPRs: [],
  cappedMerged: false,
  cappedClosedUnmerged: false,
  dailyActivity: {
    [daysAgo(1)]: 3,
    [daysAgo(5)]: 1,
    [daysAgo(14)]: 2,
    [daysAgo(30)]: 1,
    [daysAgo(60)]: 4,
    [daysAgo(90)]: 1,
  },
  streak: 3,
};

const emptyData: ContributionData = {
  ...sampleData,
  dailyActivity: {},
};

describe('renderActivityGraph', () => {
  it('produces valid SVG with correct dimensions', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    expect(svg).toContain('width="495"');
    expect(svg).toContain('height="140"');
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it('renders heatmap cells (180+ rect elements)', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    // 26 weeks x 7 days = 182 cells, plus the outer border rect
    const matches = svg.match(/<rect/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(180);
  });

  it('uses gradient colors for active days', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    const bodyAfterDefs = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');
    expect(bodyAfterDefs).toContain('#3b82f6');
  });

  it('includes month labels', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    // At least one of the common month name abbreviations should appear
    const monthAbbrevs = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const hasMonth = monthAbbrevs.some((m) => svg.includes(m));
    expect(hasMonth).toBe(true);
  });

  it('renders dark theme', () => {
    const svg = renderActivityGraph(sampleData, 'dark');
    expect(svg).toContain('#0d1117');
  });

  it('produces no #3b82f6 fill for empty activity', () => {
    const svg = renderActivityGraph(emptyData, 'light');
    // With no activity, no cell rect should have the active blue fill.
    // #3b82f6 will still appear inside the gradient <defs> — strip those out first.
    const bodyAfterDefs = svg.replace(/<defs>[\s\S]*?<\/defs>/g, '');
    expect(bodyAfterDefs).not.toContain('#3b82f6');
  });

  it('includes the crystal icon', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    expect(svg).toContain('url(#a1)');
  });

  it('includes day labels', () => {
    const svg = renderActivityGraph(sampleData, 'light');
    expect(svg).toContain('Mon');
    expect(svg).toContain('Wed');
    expect(svg).toContain('Fri');
  });
});

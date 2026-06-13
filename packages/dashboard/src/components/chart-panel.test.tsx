import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/preact';

// Mock Chart.js so the tests can observe instance lifecycle: chart-panel must
// create each Chart exactly once and update it in place on data refreshes
// instead of destroy-and-recreate, which replayed the 1.5s entrance animation
// on every refresh and PR action (#1459).
const chartMock = vi.hoisted(() => {
  interface MockChartConfig {
    type: string;
    data: { labels: unknown[]; datasets: Array<{ label?: string; data: unknown[] }> };
    options: Record<string, unknown>;
  }
  class MockChart {
    static register = vi.fn();
    type: string;
    data: MockChartConfig['data'];
    options: MockChartConfig['options'];
    update = vi.fn();
    destroy = vi.fn();
    constructor(_canvas: unknown, config: MockChartConfig) {
      this.type = config.type;
      this.data = config.data;
      this.options = config.options;
      instances.push(this);
    }
  }
  const instances: MockChart[] = [];
  return { MockChart, instances };
});

vi.mock('chart.js', () => ({
  Chart: chartMock.MockChart,
  LineController: {},
  BarController: {},
  CategoryScale: {},
  LinearScale: {},
  PointElement: {},
  LineElement: {},
  BarElement: {},
  Tooltip: {},
  Legend: {},
}));

import { ChartPanel } from './chart-panel';

const topRepos = [{ repo: 'a/b', active: 1, merged: 2, closed: 0 }];

describe('ChartPanel', () => {
  beforeEach(() => {
    chartMock.instances.length = 0;
  });

  it('renders canvas elements with aria-label and role="img"', () => {
    const { container } = render(<ChartPanel monthlyMerged={{}} topRepos={[]} theme="dark" />);
    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    canvases.forEach((canvas) => {
      expect(canvas.getAttribute('role')).toBe('img');
      expect(canvas.getAttribute('aria-label')).toBeTruthy();
    });
  });

  it('creates one line chart and one bar chart on first render', () => {
    render(<ChartPanel monthlyMerged={{ '2026-01': 3 }} topRepos={topRepos} theme="dark" />);
    expect(chartMock.instances).toHaveLength(2);
    expect(chartMock.instances.map((c) => c.type).sort()).toEqual(['bar', 'line']);
  });

  it('includes Opened and Closed datasets when monthly data is provided', () => {
    render(
      <ChartPanel
        monthlyMerged={{ '2026-01': 3 }}
        monthlyOpened={{ '2026-01': 4 }}
        monthlyClosed={{ '2026-01': 1 }}
        topRepos={topRepos}
        theme="dark"
      />,
    );
    const line = chartMock.instances.find((c) => c.type === 'line');
    expect(line!.data.datasets.map((d) => d.label)).toEqual(['Opened', 'Merged', 'Closed']);
  });

  it('updates charts in place on a data refresh instead of destroy-and-recreate (#1459)', () => {
    const { rerender } = render(<ChartPanel monthlyMerged={{ '2026-01': 3 }} topRepos={topRepos} theme="dark" />);
    expect(chartMock.instances).toHaveLength(2);
    const [line, bar] = chartMock.instances;

    // Every /api response produces fresh object identities — simulate one.
    rerender(
      <ChartPanel
        monthlyMerged={{ '2026-01': 5 }}
        topRepos={[{ repo: 'a/b', active: 2, merged: 3, closed: 1 }]}
        theme="dark"
      />,
    );

    // Same two instances, updated in place — no re-creation, no destroy.
    expect(chartMock.instances).toHaveLength(2);
    expect(line!.destroy).not.toHaveBeenCalled();
    expect(bar!.destroy).not.toHaveBeenCalled();
    expect(line!.update).toHaveBeenCalledWith('none');
    expect(bar!.update).toHaveBeenCalledWith('none');
    expect(line!.data.datasets[0]!.data).toEqual([5]);
    expect(bar!.data.datasets[0]!.data).toEqual([2]);
  });

  it('updates charts in place on a theme change (#1459)', () => {
    const { rerender } = render(<ChartPanel monthlyMerged={{ '2026-01': 3 }} topRepos={topRepos} theme="dark" />);
    const [line, bar] = chartMock.instances;

    rerender(<ChartPanel monthlyMerged={{ '2026-01': 3 }} topRepos={topRepos} theme="light" />);

    expect(chartMock.instances).toHaveLength(2);
    expect(line!.destroy).not.toHaveBeenCalled();
    expect(bar!.destroy).not.toHaveBeenCalled();
    expect(line!.update).toHaveBeenCalledWith('none');
    expect(bar!.update).toHaveBeenCalledWith('none');
  });

  it('destroys both chart instances on unmount', () => {
    const { unmount } = render(<ChartPanel monthlyMerged={{ '2026-01': 3 }} topRepos={topRepos} theme="dark" />);
    const [line, bar] = chartMock.instances;

    unmount();

    expect(line!.destroy).toHaveBeenCalledTimes(1);
    expect(bar!.destroy).toHaveBeenCalledTimes(1);
  });
});

import { useEffect, useRef } from 'preact/hooks';
import {
  Chart,
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';
import type { Theme } from '../hooks/use-theme';

// Register only what we need
Chart.register(
  LineController,
  BarController,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
);

interface ChartPanelProps {
  monthlyMerged: Record<string, number>;
  monthlyOpened?: Record<string, number>;
  monthlyClosed?: Record<string, number>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  theme: Theme;
}

// Chart.js can't read CSS vars; map theme to explicit hex values
function getChartColors(theme: Theme) {
  if (theme === 'light') {
    return {
      green: '#16a34a',
      purple: '#9333ea',
      red: '#dc2626',
      blue: '#2563eb',
      gridColor: 'rgba(15, 23, 42, 0.06)',
      textColor: '#475569',
    };
  }
  return {
    green: '#4ade80',
    purple: '#c084fc',
    red: '#fb7185',
    blue: '#60a5fa',
    gridColor: 'rgba(255, 255, 255, 0.06)',
    textColor: '#94a3b8',
  };
}

/** Get the last 12 months of YYYY-MM keys, sorted ascending. */
function getLast12Months(records: Record<string, number>[]): string[] {
  const allKeys = new Set<string>();
  for (const rec of records) {
    for (const key of Object.keys(rec)) {
      allKeys.add(key);
    }
  }
  return [...allKeys].sort().slice(-12);
}

export function ChartPanel({ monthlyMerged, monthlyOpened, monthlyClosed, topRepos, theme }: ChartPanelProps) {
  const lineCanvasRef = useRef<HTMLCanvasElement>(null);
  const barCanvasRef = useRef<HTMLCanvasElement>(null);
  const lineChartRef = useRef<Chart | null>(null);
  const barChartRef = useRef<Chart | null>(null);

  // Monthly activity line chart. Created once, then updated in place: every
  // /api/data|refresh|action response produces fresh array identities, so a
  // destroy-and-recreate here replayed the 1.5s entrance animation on every
  // refresh and PR action (#1459).
  useEffect(() => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const legendOpts = { labels: { color: colors.textColor, boxWidth: 12 } };
    const months = getLast12Months([monthlyMerged, monthlyOpened ?? {}, monthlyClosed ?? {}]);

    const datasets = [];

    if (monthlyOpened) {
      datasets.push({
        label: 'Opened',
        data: months.map((m) => monthlyOpened[m] ?? 0),
        borderColor: colors.blue,
        backgroundColor: colors.blue,
        tension: 0.3,
        pointRadius: 3,
      });
    }

    datasets.push({
      label: 'Merged',
      data: months.map((m) => monthlyMerged[m] ?? 0),
      borderColor: colors.purple,
      backgroundColor: colors.purple,
      tension: 0.3,
      pointRadius: 3,
    });

    if (monthlyClosed) {
      datasets.push({
        label: 'Closed',
        data: months.map((m) => monthlyClosed[m] ?? 0),
        borderColor: colors.red,
        backgroundColor: colors.red,
        tension: 0.3,
        pointRadius: 3,
      });
    }

    const data = { labels: months, datasets };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      // Entrance animation (#940) — visible for demos, tasteful for daily use.
      animation: { duration: 1500, easing: 'easeOutQuart' as const },
      plugins: { legend: legendOpts },
      scales: {
        x: scaleOpts,
        y: { beginAtZero: true, ...scaleOpts },
      },
    };

    const existing = lineChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      // 'none' skips the transition — the entrance animation runs only when
      // the chart is first created (#1459).
      existing.update('none');
      return;
    }
    lineChartRef.current = new Chart(canvas, { type: 'line', data, options });
  }, [monthlyMerged, monthlyOpened, monthlyClosed, theme]);

  // Top repos bar chart — same create-once-then-update-in-place pattern as
  // the line chart above (#1459).
  useEffect(() => {
    const canvas = barCanvasRef.current;
    if (!canvas) return;

    const colors = getChartColors(theme);
    const scaleOpts = { ticks: { color: colors.textColor }, grid: { color: colors.gridColor } };
    const legendOpts = { labels: { color: colors.textColor, boxWidth: 12 } };
    const repos = topRepos.slice(0, 10);
    const labels = repos.map((r) => r.repo);

    const data = {
      labels,
      datasets: [
        {
          label: 'Active',
          data: repos.map((r) => r.active),
          backgroundColor: colors.green,
        },
        {
          label: 'Merged',
          data: repos.map((r) => r.merged),
          backgroundColor: colors.purple,
        },
        {
          label: 'Closed',
          data: repos.map((r) => r.closed),
          backgroundColor: colors.red,
        },
      ],
    };
    const options = {
      responsive: true,
      maintainAspectRatio: false,
      // Entrance animation (#940) matched with the line chart so both charts
      // "come alive" together when the dashboard loads.
      animation: { duration: 1500, easing: 'easeOutQuart' as const },
      indexAxis: 'y' as const,
      plugins: { legend: legendOpts },
      scales: {
        x: { stacked: true, beginAtZero: true, ...scaleOpts },
        y: { stacked: true, ...scaleOpts },
      },
    };

    const existing = barChartRef.current;
    if (existing) {
      existing.data = data;
      existing.options = options;
      existing.update('none');
      return;
    }
    barChartRef.current = new Chart(canvas, { type: 'bar', data, options });
  }, [topRepos, theme]);

  // Destroy chart instances only on unmount — not on every data/theme change
  // (#1459); the effects above update existing instances in place.
  useEffect(
    () => () => {
      lineChartRef.current?.destroy();
      lineChartRef.current = null;
      barChartRef.current?.destroy();
      barChartRef.current = null;
    },
    [],
  );

  return (
    <div class="chart-panel">
      <div class="chart-card">
        <h3 class="chart-card-title">Monthly Activity</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={lineCanvasRef} aria-label="Monthly PR activity chart" role="img" />
        </div>
      </div>
      <div class="chart-card">
        <h3 class="chart-card-title">Top Repos</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={barCanvasRef} aria-label="Top repositories by PR count" role="img" />
        </div>
      </div>
    </div>
  );
}

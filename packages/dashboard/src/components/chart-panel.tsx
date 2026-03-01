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
}

// Chart.js can't read CSS vars, so use hex values directly
const COLORS = {
  green: '#3fb950',
  purple: '#a855f7',
  red: '#f85149',
  blue: '#58a6ff',
  gridColor: 'rgba(48, 54, 61, 0.3)',
  textColor: '#8b949e',
};

const SHARED_SCALE_OPTS = {
  ticks: { color: COLORS.textColor },
  grid: { color: COLORS.gridColor },
};

const SHARED_LEGEND = {
  labels: { color: COLORS.textColor, boxWidth: 12 },
};

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

export function ChartPanel({ monthlyMerged, monthlyOpened, monthlyClosed, topRepos }: ChartPanelProps) {
  const lineCanvasRef = useRef<HTMLCanvasElement>(null);
  const barCanvasRef = useRef<HTMLCanvasElement>(null);
  const lineChartRef = useRef<Chart | null>(null);
  const barChartRef = useRef<Chart | null>(null);

  // Monthly activity line chart
  useEffect(() => {
    const canvas = lineCanvasRef.current;
    if (!canvas) return;

    const months = getLast12Months([
      monthlyMerged,
      monthlyOpened ?? {},
      monthlyClosed ?? {},
    ]);

    const datasets = [];

    if (monthlyOpened) {
      datasets.push({
        label: 'Opened',
        data: months.map((m) => monthlyOpened[m] ?? 0),
        borderColor: COLORS.blue,
        backgroundColor: COLORS.blue,
        tension: 0.3,
        pointRadius: 3,
      });
    }

    datasets.push({
      label: 'Merged',
      data: months.map((m) => monthlyMerged[m] ?? 0),
      borderColor: COLORS.purple,
      backgroundColor: COLORS.purple,
      tension: 0.3,
      pointRadius: 3,
    });

    if (monthlyClosed) {
      datasets.push({
        label: 'Closed',
        data: months.map((m) => monthlyClosed[m] ?? 0),
        borderColor: COLORS.red,
        backgroundColor: COLORS.red,
        tension: 0.3,
        pointRadius: 3,
      });
    }

    lineChartRef.current = new Chart(canvas, {
      type: 'line',
      data: { labels: months, datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: SHARED_LEGEND },
        scales: {
          x: SHARED_SCALE_OPTS,
          y: { beginAtZero: true, ...SHARED_SCALE_OPTS },
        },
      },
    });

    return () => {
      lineChartRef.current?.destroy();
      lineChartRef.current = null;
    };
  }, [monthlyMerged, monthlyOpened, monthlyClosed]);

  // Top repos bar chart
  useEffect(() => {
    const canvas = barCanvasRef.current;
    if (!canvas) return;

    const repos = topRepos.slice(0, 10);
    const labels = repos.map((r) => r.repo);

    barChartRef.current = new Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'Active',
            data: repos.map((r) => r.active),
            backgroundColor: COLORS.green,
          },
          {
            label: 'Merged',
            data: repos.map((r) => r.merged),
            backgroundColor: COLORS.purple,
          },
          {
            label: 'Closed',
            data: repos.map((r) => r.closed),
            backgroundColor: COLORS.red,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: SHARED_LEGEND },
        scales: {
          x: { stacked: true, beginAtZero: true, ...SHARED_SCALE_OPTS },
          y: { stacked: true, ...SHARED_SCALE_OPTS },
        },
      },
    });

    return () => {
      barChartRef.current?.destroy();
      barChartRef.current = null;
    };
  }, [topRepos]);

  return (
    <div class="chart-panel">
      <div class="chart-card">
        <h3 class="chart-card-title">Monthly Activity</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={lineCanvasRef} />
        </div>
      </div>
      <div class="chart-card">
        <h3 class="chart-card-title">Top Repos</h3>
        <div class="chart-canvas-wrapper">
          <canvas ref={barCanvasRef} />
        </div>
      </div>
    </div>
  );
}

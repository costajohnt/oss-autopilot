import type { ContributionData } from './github-data.js';
import { crystalIcon, svgWrapper, theme } from './svg-utils.js';

const WIDTH = 495;
const HEIGHT = 195;

/** Build a 12-week activity sparkline polyline from dailyActivity. */
function buildSparkline(
  dailyActivity: Record<string, number>,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): string {
  // Collect last 12 weeks of weekly totals
  const now = new Date();
  const weeks: number[] = [];
  for (let i = 11; i >= 0; i--) {
    let total = 0;
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setUTCDate(now.getUTCDate() - i * 7 - d);
      const key = date.toISOString().slice(0, 10);
      total += dailyActivity[key] ?? 0;
    }
    weeks.push(total);
  }

  const max = Math.max(...weeks, 1);
  const stepX = w / (weeks.length - 1);
  const points = weeks
    .map((v, i) => {
      const px = x + i * stepX;
      const py = y + h - (v / max) * h;
      return `${px.toFixed(1)},${py.toFixed(1)}`;
    })
    .join(' ');

  return `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>`;
}

export function renderStatsCard(data: ContributionData, mode: 'light' | 'dark'): string {
  const t = theme(mode);
  const iconSize = 24;
  const iconX = 16;
  const iconY = 14;

  // Header: crystal icon + title
  const header = [
    `<g transform="translate(${iconX},${iconY})">${crystalIcon(iconSize)}</g>`,
    `<text x="${iconX + iconSize + 8}" y="${iconY + 16}" font-family="system-ui,sans-serif" font-size="14" font-weight="600" fill="${t.text}">OSS Autopilot</text>`,
  ].join('\n  ');

  // 4 metrics in a 2x2 grid
  const mergedLabel = data.cappedMerged ? `${data.merged}+` : `${data.merged}`;
  const mergeRateLabel = `${Math.round(data.mergeRate)}%`;
  const streakLabel = `${data.streak} week${data.streak !== 1 ? 's' : ''}`;

  const metrics: Array<{ value: string; label: string; color: string }> = [
    { value: mergedLabel, label: 'PRs Merged', color: '#e11d48' },
    { value: `${data.repoCount}`, label: 'Repos', color: '#3b82f6' },
    { value: mergeRateLabel, label: 'Merge Rate', color: '#22c55e' },
    { value: streakLabel, label: 'Streak', color: '#a855f7' },
  ];

  const gridTop = 58;
  const cellW = WIDTH / 2;
  const cellH = 52;

  const metricElements = metrics
    .map((m, i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const cx = col * cellW + 24;
      const cy = gridTop + row * cellH;
      return [
        `<text x="${cx}" y="${cy + 20}" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="${m.color}">${m.value}</text>`,
        `<text x="${cx}" y="${cy + 36}" font-family="system-ui,sans-serif" font-size="11" fill="${t.textSecondary}">${m.label}</text>`,
      ].join('\n  ');
    })
    .join('\n  ');

  // Sparkline at the bottom
  const sparkX = 16;
  const sparkY = HEIGHT - 36;
  const sparkW = WIDTH - 32;
  const sparkH = 22;
  const sparkline = buildSparkline(data.dailyActivity, sparkX, sparkY, sparkW, sparkH, t.textSecondary);

  // Divider line above sparkline
  const divider = `<line x1="16" y1="${HEIGHT - 44}" x2="${WIDTH - 16}" y2="${HEIGHT - 44}" stroke="${t.border}" stroke-width="0.5"/>`;

  const content = [header, metricElements, divider, sparkline].join('\n  ');

  return svgWrapper(WIDTH, HEIGHT, content, mode);
}

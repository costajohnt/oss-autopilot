import type { ContributionData } from './github-data.js';
import { crystalIcon, svgWrapper, theme } from './svg-utils.js';

const WIDTH = 495;
const HEIGHT = 140;

const WEEKS = 26;
const DAYS = 7;

// Layout constants
const LEFT_LABEL_W = 28; // space for Mon/Wed/Fri labels
const RIGHT_PAD = 12;
const HEADER_H = 38;
const BOTTOM_LABEL_H = 16;
const GRID_TOP = HEADER_H;
const GRID_BOTTOM = HEIGHT - BOTTOM_LABEL_H;
const GRID_H = GRID_BOTTOM - GRID_TOP;
const GRID_W = WIDTH - LEFT_LABEL_W - RIGHT_PAD;
const CELL_SIZE = Math.floor(Math.min(GRID_W / WEEKS, GRID_H / DAYS)) - 1;
const CELL_GAP = 1;

// Active color shades based on intensity (0 = inactive, 1-4 = intensity levels)
const ACTIVE_COLORS = ['#1d4ed8', '#2563eb', '#3b82f6', '#60a5fa']; // dark → light intensity

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS: Array<{ day: number; label: string }> = [
  { day: 0, label: 'Mon' },
  { day: 2, label: 'Wed' },
  { day: 4, label: 'Fri' },
];

function intensityColor(count: number, maxCount: number): string | null {
  if (count === 0 || maxCount === 0) return null;
  const ratio = count / maxCount;
  if (ratio <= 0.25) return ACTIVE_COLORS[3]; // lightest
  if (ratio <= 0.5) return ACTIVE_COLORS[2];
  if (ratio <= 0.75) return ACTIVE_COLORS[1];
  return ACTIVE_COLORS[0]; // darkest
}

export function renderActivityGraph(data: ContributionData, mode: 'light' | 'dark'): string {
  const t = theme(mode);

  // Build date grid: 26 columns (weeks), 7 rows (Mon-Sun), newest week on the right
  // Anchor to the Sunday that ends the current week so today always falls in the rightmost column.
  const today = new Date();
  const dayOfWeek = today.getUTCDay(); // 0=Sun ... 6=Sat
  // Days until the coming Sunday (0 if today is already Sunday)
  const daysToSunday = dayOfWeek === 0 ? 0 : 7 - dayOfWeek;
  const gridEndSunday = new Date(today);
  gridEndSunday.setUTCDate(today.getUTCDate() + daysToSunday);
  gridEndSunday.setUTCHours(0, 0, 0, 0);

  // Total cells: WEEKS * DAYS, column 0 = oldest week, column WEEKS-1 = current week
  // Each column is Mon(row0)..Sun(row6)
  // gridEndSunday is the Sunday of the last (rightmost) week — that's row 6, col WEEKS-1
  // The Monday of the last week is gridEndSunday - 6 days
  // Build an array of Date objects for the grid, row-major within each column
  // col 0, row 0 = oldest Monday
  const cells: Array<{ date: Date; col: number; row: number }> = [];
  for (let col = WEEKS - 1; col >= 0; col--) {
    // Monday of this column week
    const colMondayOffset = (WEEKS - 1 - col) * 7 + 6; // days before gridEndSunday to reach this Monday
    for (let row = 0; row < DAYS; row++) {
      const d = new Date(gridEndSunday);
      d.setUTCDate(gridEndSunday.getUTCDate() - colMondayOffset + row);
      cells.push({ date: d, col, row });
    }
  }

  // Find max count for intensity scaling
  const counts = cells.map((c) => data.dailyActivity[c.date.toISOString().slice(0, 10)] ?? 0);
  const maxCount = Math.max(...counts, 1);

  // Build cell rects
  const cellX = (col: number) => LEFT_LABEL_W + col * (CELL_SIZE + CELL_GAP);
  const cellY = (row: number) => GRID_TOP + row * (CELL_SIZE + CELL_GAP);

  const cellRects = cells
    .map(({ date, col, row }) => {
      const key = date.toISOString().slice(0, 10);
      const count = data.dailyActivity[key] ?? 0;
      const active = intensityColor(count, maxCount);
      const fill = active ?? t.cardBg;
      const stroke = active ? 'none' : t.border;
      const strokeAttr = active ? '' : ` stroke="${stroke}" stroke-width="0.5"`;
      return `<rect x="${cellX(col)}" y="${cellY(row)}" width="${CELL_SIZE}" height="${CELL_SIZE}" rx="1.5" fill="${fill}"${strokeAttr}/>`;
    })
    .join('\n  ');

  // Day labels (Mon, Wed, Fri) on the left
  const dayLabelElements = DAY_LABELS.map(({ day, label }) => {
    const y = cellY(day) + CELL_SIZE - 1;
    return `<text x="${LEFT_LABEL_W - 4}" y="${y}" font-family="system-ui,sans-serif" font-size="8" fill="${t.textSecondary}" text-anchor="end">${label}</text>`;
  }).join('\n  ');

  // Month labels at the bottom — show month name when a new month starts in a column
  const monthLabelElements: string[] = [];
  let lastMonth = -1;
  for (let col = 0; col < WEEKS; col++) {
    // Use the Monday of this column
    const colMondayOffset = (WEEKS - 1 - col) * 7 + 6;
    const colMonday = new Date(gridEndSunday);
    colMonday.setUTCDate(gridEndSunday.getUTCDate() - colMondayOffset);
    const month = colMonday.getUTCMonth();
    if (month !== lastMonth) {
      lastMonth = month;
      const x = cellX(col);
      monthLabelElements.push(
        `<text x="${x}" y="${GRID_BOTTOM + 12}" font-family="system-ui,sans-serif" font-size="9" fill="${t.textSecondary}">${MONTH_NAMES[month]}</text>`,
      );
    }
  }
  const monthLabels = monthLabelElements.join('\n  ');

  // Header
  const iconSize = 20;
  const iconX = 14;
  const iconY = 10;
  const header = [
    `<g transform="translate(${iconX},${iconY})">${crystalIcon(iconSize)}</g>`,
    `<text x="${iconX + iconSize + 8}" y="${iconY + 14}" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="${t.text}">Activity</text>`,
  ].join('\n  ');

  const content = [header, cellRects, dayLabelElements, monthLabels].join('\n  ');
  return svgWrapper(WIDTH, HEIGHT, content, mode);
}

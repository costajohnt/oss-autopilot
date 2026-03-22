import type { ContributionData } from './github-data.js';
import { crystalIcon, svgWrapper, theme, REPO_COLORS, truncate, escapeXml } from './svg-utils.js';

const WIDTH = 495;
const ROW_H = 36;
const HEADER_H = 44;
const FOOTER_PAD = 12;

function timeAgo(dateStr: string): string {
  const ts = new Date(dateStr).getTime();
  if (isNaN(ts)) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60000) return 'just now'; // handles negative and very recent
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  const diffDays = Math.floor(diffHr / 24);
  if (diffDays < 30) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
  const diffMonths = Math.floor(diffDays / 30);
  if (diffMonths < 12) return `${diffMonths} mo ago`;
  const diffYears = Math.floor(diffMonths / 12);
  return `${diffYears} yr ago`;
}

export function renderRecentCard(data: ContributionData, mode: 'light' | 'dark'): string {
  const t = theme(mode);
  const prs = data.recentPRs.slice(0, 5);

  const HEIGHT = HEADER_H + Math.max(prs.length, 1) * ROW_H + FOOTER_PAD;

  const iconSize = 20;
  const iconX = 14;
  const iconY = 12;

  const header = [
    `<g transform="translate(${iconX},${iconY})">${crystalIcon(iconSize)}</g>`,
    `<text x="${iconX + iconSize + 8}" y="${iconY + 14}" font-family="system-ui,sans-serif" font-size="13" font-weight="600" fill="${t.text}">Recent Contributions</text>`,
  ].join('\n  ');

  let rows: string;

  if (prs.length === 0) {
    const cy = HEADER_H + ROW_H / 2 + 6;
    rows = `<text x="${WIDTH / 2}" y="${cy}" font-family="system-ui,sans-serif" font-size="12" fill="${t.textSecondary}" text-anchor="middle">No recent contributions</text>`;
  } else {
    rows = prs
      .map((pr, i) => {
        const color = REPO_COLORS[i % REPO_COLORS.length];
        const y = HEADER_H + i * ROW_H;
        const barX = 14;
        const barY = y + 8;
        const barW = 3;
        const barH = ROW_H - 16;

        const repoName = escapeXml(pr.repo.split('/').pop() ?? pr.repo);
        const title = escapeXml(truncate(pr.title, 40));
        const ago = timeAgo(pr.mergedAt);

        return [
          `<rect x="${barX}" y="${barY}" width="${barW}" height="${barH}" rx="1.5" fill="${color}"/>`,
          `<text x="${barX + barW + 8}" y="${y + 20}" font-family="system-ui,sans-serif" font-size="11" font-weight="600" fill="${color}">${repoName}</text>`,
          `<text x="${barX + barW + 8}" y="${y + 32}" font-family="system-ui,sans-serif" font-size="11" fill="${t.textSecondary}">${title}</text>`,
          `<text x="${WIDTH - 14}" y="${y + 20}" font-family="system-ui,sans-serif" font-size="10" fill="${t.textSecondary}" text-anchor="end">${escapeXml(ago)}</text>`,
        ].join('\n  ');
      })
      .join('\n  ');
  }

  const content = [header, rows].join('\n  ');
  return svgWrapper(WIDTH, HEIGHT, content, mode);
}

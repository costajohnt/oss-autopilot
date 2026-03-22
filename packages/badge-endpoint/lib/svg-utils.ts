export interface ThemeColors {
  bg: string;
  text: string;
  textSecondary: string;
  border: string;
  cardBg: string;
}

export function theme(mode: 'light' | 'dark'): ThemeColors {
  if (mode === 'dark') {
    return { bg: '#0d1117', text: '#e6edf3', textSecondary: '#8b949e', border: '#30363d', cardBg: '#161b22' };
  }
  return { bg: '#ffffff', text: '#1e293b', textSecondary: '#64748b', border: '#e2e8f0', cardBg: '#f8fafc' };
}

export function gradientDefs(): string {
  return `<defs>
    <linearGradient id="a1" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fb7185"/><stop offset="100%" stop-color="#e11d48"/></linearGradient>
    <linearGradient id="a2" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#fbbf24"/><stop offset="100%" stop-color="#d97706"/></linearGradient>
    <linearGradient id="a3" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#60a5fa"/><stop offset="100%" stop-color="#3b82f6"/></linearGradient>
    <linearGradient id="a4" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#c084fc"/><stop offset="100%" stop-color="#a855f7"/></linearGradient>
    <linearGradient id="a5" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#4ade80"/><stop offset="100%" stop-color="#22c55e"/></linearGradient>
    <linearGradient id="a6" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#a78bfa"/><stop offset="100%" stop-color="#7c3aed"/></linearGradient>
  </defs>`;
}

export function crystalIcon(size: number): string {
  const scale = size / 180;
  return `<g transform="scale(${scale.toFixed(3)})">
    <polygon points="90,0 140,50 120,90 60,90 40,50" fill="url(#a3)" opacity="0.9"/>
    <polygon points="90,0 40,50 60,90" fill="url(#a1)" opacity="0.85"/>
    <polygon points="90,0 140,50 120,90" fill="url(#a4)" opacity="0.85"/>
    <polygon points="60,90 120,90 110,140 70,140" fill="url(#a5)" opacity="0.9"/>
    <polygon points="70,140 110,140 90,180" fill="url(#a6)" opacity="0.85"/>
    <polygon points="60,90 70,140 90,180" fill="url(#a2)" opacity="0.8"/>
    <polygon points="120,90 110,140 90,180" fill="url(#a1)" opacity="0.8"/>
  </g>`;
}

export function svgWrapper(width: number, height: number, content: string, mode: 'light' | 'dark'): string {
  const t = theme(mode);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" fill="none">
  ${gradientDefs()}
  <rect width="${width}" height="${height}" rx="8" fill="${t.bg}" stroke="${t.border}" stroke-width="1"/>
  ${content}
</svg>`;
}

export const REPO_COLORS = ['#e11d48', '#d97706', '#3b82f6', '#a855f7', '#22c55e', '#7c3aed'];

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

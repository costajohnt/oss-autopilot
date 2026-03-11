import type React from 'react';

/**
 * Design tokens extracted from packages/dashboard/src/styles.css
 * These keep the video visually consistent with the dashboard.
 */

export const colors = {
  base: '#0c0e14',
  surface: 'rgba(18, 22, 32, 0.7)',
  elevated: 'rgba(24, 28, 40, 0.85)',
  border: 'rgba(255, 255, 255, 0.08)',
  green: '#4ade80',
  purple: '#c084fc',
  red: '#fb7185',
  blue: '#60a5fa',
  amber: '#fbbf24',
  greenDim: 'rgba(74, 222, 128, 0.1)',
  purpleDim: 'rgba(192, 132, 252, 0.1)',
  redDim: 'rgba(251, 113, 133, 0.1)',
  blueDim: 'rgba(96, 165, 250, 0.08)',
  amberDim: 'rgba(251, 191, 36, 0.1)',
  textPrimary: '#f1f5f9',
  textSecondary: '#94a3b8',
  textMuted: '#64748b',
  atmosphereBlue: 'rgba(96, 165, 250, 0.08)',
  atmospherePurple: 'rgba(192, 132, 252, 0.06)',
} as const;

export const fonts = {
  body: "'Plus Jakarta Sans', system-ui, sans-serif",
  mono: "'JetBrains Mono', 'Fira Code', monospace",
} as const;

export const fontSizes = {
  title: 64,
  subtitle: 42,
  body: 36,
  code: 28,
  label: 24,
  small: 20,
} as const;

export const fontWeights = {
  title: 800,
  subtitle: 600,
  body: 500,
  code: 400,
  label: 600,
} as const;

export const easing = {
  /** Dashboard ease: cubic-bezier(0.22, 1, 0.36, 1) — fast start, gentle deceleration */
  default: [0.22, 1, 0.36, 1] as [number, number, number, number],
} as const;

export const springConfig = {
  default: { damping: 12, mass: 0.5 },
  gentle: { damping: 15, mass: 0.8 },
  snappy: { damping: 10, mass: 0.3 },
} as const;

/** Gradient definitions from the logo SVG */
export const logoGradients = {
  a1: ['#fb7185', '#e11d48'], // red-pink
  a2: ['#fbbf24', '#d97706'], // amber
  a3: ['#60a5fa', '#3b82f6'], // blue
  a4: ['#c084fc', '#a855f7'], // purple
  a5: ['#4ade80', '#22c55e'], // green
  a6: ['#a78bfa', '#7c3aed'], // violet
} as const;

/** Shared background for all scenes — atmospheric blue/purple gradient */
export const atmosphericBackground: React.CSSProperties = {
  position: 'absolute',
  inset: 0,
  background: `
    radial-gradient(ellipse 80% 50% at 50% 0%, ${colors.atmosphereBlue} 0%, transparent 60%),
    radial-gradient(ellipse 60% 40% at 50% 100%, ${colors.atmospherePurple} 0%, transparent 50%)
  `,
  pointerEvents: 'none',
};

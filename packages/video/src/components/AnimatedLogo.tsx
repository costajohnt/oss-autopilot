import React from 'react';
import { useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { springConfig } from '../design-tokens';

/**
 * Polygon data from packages/dashboard/public/favicon.svg.
 * Each polygon has its points, fill gradient ID, and optional opacity.
 */
const FILLED_POLYGONS: {
  points: string;
  fill: string;
  opacity?: number;
}[] = [
  { points: '256,60 300,175 256,155', fill: 'url(#a1)' },
  { points: '256,60 212,175 256,155', fill: 'url(#a3)' },
  { points: '212,175 130,250 175,220', fill: 'url(#a4)' },
  { points: '212,175 175,220 240,200', fill: 'url(#a6)', opacity: 0.8 },
  { points: '300,175 382,250 337,220', fill: 'url(#a2)' },
  { points: '300,175 337,220 272,200', fill: 'url(#a5)', opacity: 0.8 },
  { points: '256,155 240,200 256,250 272,200', fill: 'url(#a1)', opacity: 0.6 },
  { points: '130,250 150,340 195,280', fill: 'url(#a5)' },
  { points: '175,220 130,250 195,280', fill: 'url(#a3)', opacity: 0.7 },
  { points: '195,280 240,200 256,250', fill: 'url(#a4)', opacity: 0.5 },
  { points: '382,250 362,340 317,280', fill: 'url(#a6)' },
  { points: '337,220 382,250 317,280', fill: 'url(#a2)', opacity: 0.7 },
  { points: '317,280 272,200 256,250', fill: 'url(#a1)', opacity: 0.5 },
  { points: '195,280 150,340 210,380', fill: 'url(#a2)', opacity: 0.8 },
  { points: '317,280 362,340 302,380', fill: 'url(#a4)', opacity: 0.8 },
  { points: '195,280 256,250 256,340', fill: 'url(#a3)', opacity: 0.6 },
  { points: '317,280 256,250 256,340', fill: 'url(#a5)', opacity: 0.6 },
  { points: '210,380 256,340 256,440', fill: 'url(#a6)', opacity: 0.7 },
  { points: '302,380 256,340 256,440', fill: 'url(#a1)', opacity: 0.7 },
  { points: '150,340 210,380 190,410', fill: 'url(#a5)', opacity: 0.5 },
  { points: '362,340 302,380 322,410', fill: 'url(#a3)', opacity: 0.5 },
];

const EDGE_POLYGONS: string[] = [
  '256,60 300,175 256,155',
  '256,60 212,175 256,155',
  '212,175 130,250 175,220',
  '300,175 382,250 337,220',
  '256,155 240,200 256,250 272,200',
  '130,250 150,340 195,280',
  '382,250 362,340 317,280',
  '195,280 150,340 210,380',
  '317,280 362,340 302,380',
  '210,380 256,340 256,440',
  '302,380 256,340 256,440',
  '150,340 210,380 190,410',
  '362,340 302,380 322,410',
];

interface AnimatedLogoProps {
  size?: number;
  /** Frame at which the animation starts */
  startFrame?: number;
  /** Stagger gap between facets (frames) */
  stagger?: number;
  /** Whether to show edge lines drawing in */
  showEdges?: boolean;
  style?: React.CSSProperties;
}

export const AnimatedLogo: React.FC<AnimatedLogoProps> = ({
  size = 300,
  startFrame = 0,
  stagger = 3,
  showEdges = true,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      style={{
        filter: 'drop-shadow(0 0 20px rgba(96,165,250,0.25)) drop-shadow(0 0 40px rgba(192,132,252,0.15))',
        ...style,
      }}
    >
      <defs>
        <linearGradient id="a1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fb7185" />
          <stop offset="100%" stopColor="#e11d48" />
        </linearGradient>
        <linearGradient id="a2" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#fbbf24" />
          <stop offset="100%" stopColor="#d97706" />
        </linearGradient>
        <linearGradient id="a3" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#3b82f6" />
        </linearGradient>
        <linearGradient id="a4" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#c084fc" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
        <linearGradient id="a5" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#4ade80" />
          <stop offset="100%" stopColor="#22c55e" />
        </linearGradient>
        <linearGradient id="a6" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#a78bfa" />
          <stop offset="100%" stopColor="#7c3aed" />
        </linearGradient>
      </defs>

      {/* Filled facets — staggered spring entrance */}
      {FILLED_POLYGONS.map((poly, i) => {
        const s = spring({
          frame: frame - startFrame - i * stagger,
          fps,
          config: springConfig.default,
        });
        return (
          <polygon
            key={`fill-${i}`}
            points={poly.points}
            fill={poly.fill}
            opacity={(poly.opacity ?? 1) * s}
            style={{
              transformOrigin: '256px 250px',
              transform: `scale(${0.8 + 0.2 * s})`,
            }}
          />
        );
      })}

      {/* White stained glass edges — strokeDashoffset draw-in */}
      {showEdges &&
        EDGE_POLYGONS.map((points, i) => {
          const edgeStart = startFrame + FILLED_POLYGONS.length * stagger + i * 2;
          const edgeProgress = spring({
            frame: frame - edgeStart,
            fps,
            config: springConfig.gentle,
          });
          // Approximate perimeter for dash animation
          const perimeter = 600;
          return (
            <polygon
              key={`edge-${i}`}
              points={points}
              fill="none"
              stroke="rgba(255,255,255,0.25)"
              strokeWidth={1.2}
              strokeDasharray={perimeter}
              strokeDashoffset={perimeter * (1 - edgeProgress)}
            />
          );
        })}
    </svg>
  );
};

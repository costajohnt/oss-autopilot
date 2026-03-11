import React from 'react';
import { useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors, fonts, fontSizes, springConfig } from '../design-tokens';

interface AgentIconProps {
  name: string;
  description: string;
  color: string;
  startFrame?: number;
  size?: number;
  style?: React.CSSProperties;
}

/** Hexagonal agent avatar with animated entrance */
export const AgentIcon: React.FC<AgentIconProps> = ({ name, description, color, startFrame = 0, size = 80, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame: frame - startFrame,
    fps,
    config: springConfig.default,
  });

  // Hexagon SVG path (pointy-top)
  const hexPath = `M${size / 2} 0 L${size} ${size * 0.25} L${size} ${size * 0.75} L${size / 2} ${size} L0 ${size * 0.75} L0 ${size * 0.25} Z`;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        opacity: scale,
        transform: `scale(${scale})`,
        ...style,
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ filter: `drop-shadow(0 0 12px ${color})` }}
      >
        <path d={hexPath} fill={color} opacity={0.2} />
        <path d={hexPath} fill="none" stroke={color} strokeWidth={2} opacity={0.8} />
        {/* Center icon — simple gear/cog placeholder */}
        <circle cx={size / 2} cy={size / 2} r={size * 0.15} fill={color} opacity={0.6} />
      </svg>
      <span
        style={{
          fontFamily: fonts.mono,
          fontSize: fontSizes.small - 4,
          color,
          fontWeight: 600,
          whiteSpace: 'nowrap',
        }}
      >
        {name}
      </span>
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: fontSizes.small - 6,
          color: colors.textSecondary,
          textAlign: 'center',
          maxWidth: 140,
          lineHeight: 1.3,
        }}
      >
        {description}
      </span>
    </div>
  );
};

import React from 'react';
import { useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors, fonts, fontSizes, fontWeights } from '../design-tokens';

interface FeatureCalloutProps {
  text: string;
  color?: string;
  startFrame?: number;
  x?: number;
  y?: number;
  style?: React.CSSProperties;
}

export const FeatureCallout: React.FC<FeatureCalloutProps> = ({
  text,
  color = colors.blue,
  startFrame = 0,
  x = 0,
  y = 0,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 12, mass: 0.5 },
  });

  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        opacity: progress,
        transform: `translateY(${(1 - progress) * 15}px)`,
        ...style,
      }}
    >
      <div
        style={{
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          boxShadow: `0 0 10px ${color}`,
        }}
      />
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: fontSizes.label,
          fontWeight: fontWeights.label,
          color: colors.textPrimary,
          background: colors.surface,
          padding: '6px 14px',
          borderRadius: 8,
          border: `1px solid ${colors.border}`,
        }}
      >
        {text}
      </span>
    </div>
  );
};

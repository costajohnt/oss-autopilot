import React from 'react';
import { useCurrentFrame, interpolate } from 'remotion';
import { fonts, fontSizes, fontWeights } from '../design-tokens';

interface SearchLaneProps {
  label: string;
  color: string;
  startFrame?: number;
  duration?: number;
  width?: number;
  style?: React.CSSProperties;
}

/** Animated progress lane for the issue discovery scene */
export const SearchLane: React.FC<SearchLaneProps> = ({
  label,
  color,
  startFrame = 0,
  duration = 60,
  width = 300,
  style,
}) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;

  const progress = interpolate(elapsed, [0, duration], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const labelOpacity = interpolate(elapsed, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 16, ...style }}>
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: fontSizes.label,
          fontWeight: fontWeights.label,
          color,
          opacity: labelOpacity,
          minWidth: 220,
          textAlign: 'right',
        }}
      >
        {label}
      </span>
      <div
        style={{
          width,
          height: 8,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.06)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${progress * 100}%`,
            height: '100%',
            borderRadius: 4,
            background: `linear-gradient(90deg, ${color}, ${color}80)`,
            boxShadow: `0 0 12px ${color}60`,
          }}
        />
      </div>
    </div>
  );
};

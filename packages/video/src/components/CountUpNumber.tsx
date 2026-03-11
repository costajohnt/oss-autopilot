import React from 'react';
import { useCurrentFrame, interpolate } from 'remotion';
import { colors, fonts, fontWeights } from '../design-tokens';

interface CountUpNumberProps {
  target: number;
  startFrame?: number;
  duration?: number;
  color?: string;
  fontSize?: number;
  style?: React.CSSProperties;
}

export const CountUpNumber: React.FC<CountUpNumberProps> = ({
  target,
  startFrame = 0,
  duration = 30,
  color = colors.green,
  fontSize = 48,
  style,
}) => {
  const frame = useCurrentFrame();
  const value = interpolate(frame - startFrame, [0, duration], [0, target], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <span
      style={{
        fontFamily: fonts.body,
        fontWeight: fontWeights.title,
        fontSize,
        color,
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {Math.round(value)}
    </span>
  );
};

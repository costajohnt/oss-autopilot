import React from 'react';
import { colors, fonts, fontSizes, fontWeights } from '../design-tokens';

interface GradientTextProps {
  children: React.ReactNode;
  style?: React.CSSProperties;
  fontSize?: number;
  fontWeight?: number;
  from?: string;
  to?: string;
}

export const GradientText: React.FC<GradientTextProps> = ({
  children,
  style,
  fontSize = fontSizes.title,
  fontWeight = fontWeights.title,
  from = colors.textPrimary,
  to = colors.blue,
}) => (
  <span
    style={{
      fontFamily: fonts.body,
      fontSize,
      fontWeight,
      letterSpacing: '-0.03em',
      background: `linear-gradient(135deg, ${from} 0%, ${to} 100%)`,
      WebkitBackgroundClip: 'text',
      WebkitTextFillColor: 'transparent',
      backgroundClip: 'text',
      ...style,
    }}
  >
    {children}
  </span>
);

import React from 'react';
import { colors, fonts } from '../design-tokens';

interface TerminalWindowProps {
  children: React.ReactNode;
  title?: string;
  width?: number | string;
  style?: React.CSSProperties;
}

export const TerminalWindow: React.FC<TerminalWindowProps> = ({
  children,
  title = 'Terminal',
  width = '100%',
  style,
}) => (
  <div
    style={{
      width,
      background: 'rgba(10, 12, 18, 0.95)',
      borderRadius: 12,
      border: `1px solid ${colors.border}`,
      overflow: 'hidden',
      boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
      ...style,
    }}
  >
    {/* Title bar */}
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '12px 16px',
        background: 'rgba(18, 22, 32, 0.8)',
        borderBottom: `1px solid ${colors.border}`,
      }}
    >
      <div style={{ display: 'flex', gap: 8 }}>
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: colors.red,
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: colors.amber,
          }}
        />
        <div
          style={{
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: colors.green,
          }}
        />
      </div>
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: 13,
          color: colors.textMuted,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {title}
      </span>
    </div>
    {/* Content */}
    <div
      style={{
        padding: '20px 24px',
        fontFamily: fonts.mono,
        fontSize: 22,
        lineHeight: 1.6,
        color: colors.textPrimary,
      }}
    >
      {children}
    </div>
  </div>
);

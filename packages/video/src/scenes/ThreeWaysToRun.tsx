import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontSizes, fontWeights, atmosphericBackground } from '../design-tokens';

interface ThreeWaysToRunProps {
  format: 'landscape' | 'square';
}

interface ColumnData {
  color: string;
  startFrame: number;
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  description: string;
}

const TerminalIcon: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect x="4" y="8" width="40" height="32" rx="4" stroke={color} strokeWidth="2.5" fill="none" />
    <text
      x="24"
      y="29"
      textAnchor="middle"
      fill={color}
      fontFamily="'JetBrains Mono', monospace"
      fontSize="16"
      fontWeight="700"
    >
      {'>_'}
    </text>
  </svg>
);

const NetworkIcon: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    {/* Center node */}
    <circle cx="24" cy="24" r="5" fill={color} />
    {/* Outer nodes */}
    <circle cx="10" cy="12" r="3.5" fill={color} opacity="0.7" />
    <circle cx="38" cy="12" r="3.5" fill={color} opacity="0.7" />
    <circle cx="10" cy="36" r="3.5" fill={color} opacity="0.7" />
    <circle cx="38" cy="36" r="3.5" fill={color} opacity="0.7" />
    {/* Connecting lines */}
    <line x1="24" y1="24" x2="10" y2="12" stroke={color} strokeWidth="1.5" opacity="0.5" />
    <line x1="24" y1="24" x2="38" y2="12" stroke={color} strokeWidth="1.5" opacity="0.5" />
    <line x1="24" y1="24" x2="10" y2="36" stroke={color} strokeWidth="1.5" opacity="0.5" />
    <line x1="24" y1="24" x2="38" y2="36" stroke={color} strokeWidth="1.5" opacity="0.5" />
  </svg>
);

const PromptIcon: React.FC<{ color: string; size: number }> = ({ color, size }) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <rect x="4" y="8" width="40" height="32" rx="4" stroke={color} strokeWidth="2.5" fill="none" />
    <text
      x="24"
      y="29"
      textAnchor="middle"
      fill={color}
      fontFamily="'JetBrains Mono', monospace"
      fontSize="18"
      fontWeight="700"
    >
      $
    </text>
  </svg>
);

export const ThreeWaysToRun: React.FC<ThreeWaysToRunProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const iconSize = isSquare ? 48 : 56;

  const columns: ColumnData[] = [
    {
      color: colors.blue,
      startFrame: 15,
      icon: <TerminalIcon color={colors.blue} size={iconSize} />,
      title: 'Claude Code Plugin',
      detail: (
        <span style={{ fontFamily: fonts.mono, fontSize: isSquare ? 18 : fontSizes.code, color: colors.textSecondary }}>
          /oss &nbsp; /setup-oss
        </span>
      ),
      description: 'Full interactive experience',
    },
    {
      color: colors.purple,
      startFrame: 30,
      icon: <NetworkIcon color={colors.purple} size={iconSize} />,
      title: 'MCP Server',
      detail: (
        <span
          style={{ fontFamily: fonts.body, fontSize: isSquare ? 16 : fontSizes.small, color: colors.textSecondary }}
        >
          Cursor &middot; Claude Desktop &middot; Codex &middot; Windsurf
        </span>
      ),
      description: '20 tools. Works everywhere.',
    },
    {
      color: colors.green,
      startFrame: 45,
      icon: <PromptIcon color={colors.green} size={iconSize} />,
      title: 'Standalone CLI',
      detail: (
        <span
          style={{ fontFamily: fonts.mono, fontSize: isSquare ? 16 : fontSizes.label, color: colors.textSecondary }}
        >
          npm i -g @oss-autopilot/core
        </span>
      ),
      description: '26 commands. --json output.',
    },
  ];

  // Connecting bar animation
  const barProgress = spring({
    frame: frame - 80,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const barOpacity = barProgress;
  const barScaleX = interpolate(barProgress, [0, 1], [0, 1]);

  // Card dimensions
  const cardWidth = isSquare ? 900 : 500;
  const cardHeight = isSquare ? 180 : 340;
  const cardGap = isSquare ? 20 : 40;

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: colors.base,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Atmospheric gradient overlay */}
      <div style={atmosphericBackground} />

      {/* Columns container */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: isSquare ? 'column' : 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: cardGap,
        }}
      >
        {columns.map((col) => {
          const colProgress = spring({
            frame: frame - col.startFrame,
            fps,
            config: { damping: 12, mass: 0.5 },
          });
          const translateY = interpolate(colProgress, [0, 1], [60, 0]);
          const opacity = colProgress;

          return (
            <div
              key={col.title}
              style={{
                width: cardWidth,
                height: cardHeight,
                backgroundColor: colors.surface,
                borderRadius: 16,
                border: `1px solid ${colors.border}`,
                borderTop: `3px solid ${col.color}`,
                opacity,
                transform: `translateY(${translateY}px)`,
                display: 'flex',
                flexDirection: isSquare ? 'row' : 'column',
                alignItems: isSquare ? 'center' : 'flex-start',
                padding: isSquare ? '24px 32px' : '36px 32px',
                gap: isSquare ? 24 : 16,
                boxSizing: 'border-box',
              }}
            >
              {/* Icon */}
              <div
                style={{
                  flexShrink: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: iconSize + 16,
                  height: iconSize + 16,
                  borderRadius: 12,
                  backgroundColor: `${col.color}11`,
                }}
              >
                {col.icon}
              </div>

              {/* Text content */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: isSquare ? 6 : 12,
                  flex: 1,
                }}
              >
                {/* Title */}
                <span
                  style={{
                    fontFamily: fonts.body,
                    fontSize: isSquare ? fontSizes.body - 4 : fontSizes.body,
                    fontWeight: fontWeights.subtitle,
                    color: colors.textPrimary,
                  }}
                >
                  {col.title}
                </span>

                {/* Detail (command or client list) */}
                <div>{col.detail}</div>

                {/* Description */}
                <span
                  style={{
                    fontFamily: fonts.body,
                    fontSize: isSquare ? fontSizes.small - 2 : fontSizes.label,
                    fontWeight: fontWeights.body,
                    color: colors.textMuted,
                  }}
                >
                  {col.description}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Connecting bar below columns */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginTop: isSquare ? 28 : 48,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          opacity: barOpacity,
        }}
      >
        {/* Horizontal line */}
        <div
          style={{
            width: isSquare ? 700 : 1400,
            height: 2,
            background: `linear-gradient(90deg, transparent, ${colors.border}, ${colors.textMuted}, ${colors.border}, transparent)`,
            transform: `scaleX(${barScaleX})`,
            transformOrigin: 'center',
            marginBottom: 20,
          }}
        />

        {/* Tagline */}
        <span
          style={{
            fontFamily: fonts.body,
            fontSize: isSquare ? fontSizes.label : fontSizes.body,
            fontWeight: fontWeights.subtitle,
            color: colors.textSecondary,
            letterSpacing: '0.04em',
          }}
        >
          Same engine. Your choice.
        </span>
      </div>
    </div>
  );
};

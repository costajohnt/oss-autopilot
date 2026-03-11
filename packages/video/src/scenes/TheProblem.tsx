import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontWeights, atmosphericBackground } from '../design-tokens';

interface TheProblemProps {
  format: 'landscape' | 'square';
}

/**
 * Renders a string with specific numbers highlighted in a given color.
 * Numbers are matched by their string value and colored on first occurrence.
 */
const ColoredLine: React.FC<{
  text: string;
  highlights: { value: string; color: string }[];
  style?: React.CSSProperties;
}> = ({ text, highlights, style }) => {
  if (highlights.length === 0) {
    return <span style={style}>{text}</span>;
  }

  const parts: React.ReactNode[] = [];
  let remaining = text;
  let partIndex = 0;

  const nextKey = () => `p${partIndex++}`;

  while (remaining.length > 0) {
    let earliest: { index: number; value: string; color: string } | null = null;
    for (const h of highlights) {
      const idx = remaining.indexOf(h.value);
      if (idx !== -1 && (earliest === null || idx < earliest.index)) {
        earliest = { index: idx, value: h.value, color: h.color };
      }
    }

    if (earliest === null) {
      parts.push(<span key={nextKey()}>{remaining}</span>);
      break;
    }

    if (earliest.index > 0) {
      parts.push(<span key={nextKey()}>{remaining.slice(0, earliest.index)}</span>);
    }

    parts.push(
      <span key={nextKey()} style={{ color: earliest.color, fontWeight: fontWeights.title }}>
        {earliest.value}
      </span>,
    );

    remaining = remaining.slice(earliest.index + earliest.value.length);
  }

  return <span style={style}>{parts}</span>;
};

export const TheProblem: React.FC<TheProblemProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const baseFontSize = isSquare ? 40 : 48;
  const lineGap = isSquare ? 60 : 72;
  const topPadding = isSquare ? 280 : 300;

  // Line 1: slides in from left at frame 15
  const line1Progress = spring({
    frame: frame - 15,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const line1X = interpolate(line1Progress, [0, 1], [-600, 0]);
  const line1Opacity = line1Progress;

  // Line 2: slides in from left at frame 50
  const line2Progress = spring({
    frame: frame - 50,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const line2X = interpolate(line2Progress, [0, 1], [-600, 0]);
  const line2Opacity = line2Progress;

  // Line 3: appears at frame 100, centered with pulse
  const line3Progress = spring({
    frame: frame - 100,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const line3Opacity = line3Progress;

  // Subtle scale pulse for line 3: a gentle oscillation after it appears
  const pulseElapsed = Math.max(0, frame - 115);
  const pulse = 1 + 0.03 * Math.sin((pulseElapsed / fps) * Math.PI * 2);
  const line3Scale = interpolate(line3Progress, [0, 1], [0.85, pulse]);

  const lineStyle: React.CSSProperties = {
    fontFamily: fonts.body,
    fontSize: baseFontSize,
    fontWeight: fontWeights.subtitle,
    color: colors.textPrimary,
    whiteSpace: 'nowrap',
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: colors.base,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Atmospheric gradient overlay */}
      <div style={atmosphericBackground} />

      {/* Line 1 */}
      <div
        style={{
          position: 'absolute',
          top: topPadding,
          left: isSquare ? 60 : 120,
          transform: `translateX(${line1X}px)`,
          opacity: line1Opacity,
          zIndex: 1,
        }}
      >
        <ColoredLine
          text="You opened 12 PRs across 8 repos."
          highlights={[
            { value: '12', color: colors.green },
            { value: '8', color: colors.green },
          ]}
          style={lineStyle}
        />
      </div>

      {/* Line 2 */}
      <div
        style={{
          position: 'absolute',
          top: topPadding + lineGap,
          left: isSquare ? 60 : 120,
          transform: `translateX(${line2X}px)`,
          opacity: line2Opacity,
          zIndex: 1,
        }}
      >
        <ColoredLine
          text="3 need rebasing. 2 have maintainer questions."
          highlights={[
            { value: '3', color: colors.red },
            { value: '2', color: colors.red },
          ]}
          style={lineStyle}
        />
      </div>

      {/* Line 3 — centered with pulse */}
      <div
        style={{
          position: 'absolute',
          top: topPadding + lineGap * 2.5,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          opacity: line3Opacity,
          transform: `scale(${line3Scale})`,
          zIndex: 1,
        }}
      >
        <span
          style={{
            ...lineStyle,
            fontSize: baseFontSize + 8,
            fontWeight: fontWeights.title,
            color: colors.amber,
          }}
        >
          Which ones do you fix first?
        </span>
      </div>
    </div>
  );
};

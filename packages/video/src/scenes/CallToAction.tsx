import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontSizes, fontWeights, atmosphericBackground } from '../design-tokens';
import { GradientText } from '../components/GradientText';
import { AnimatedLogo } from '../components/AnimatedLogo';

interface CallToActionProps {
  format: 'landscape' | 'square';
}

interface LinkEntry {
  text: string;
  color: string;
}

export const CallToAction: React.FC<CallToActionProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const logoSize = isSquare ? 160 : 200;
  const titleFontSize = isSquare ? 52 : fontSizes.title;
  const subtitleFontSize = isSquare ? 30 : fontSizes.subtitle;
  const linkFontSize = isSquare ? 22 : fontSizes.code;
  const sectionGap = isSquare ? 16 : 24;

  // Logo breathing / floating animation — gentle Y oscillation
  const breathY = interpolate(Math.sin((frame / 60) * Math.PI * 2), [-1, 1], [-5, 5]);

  // Title spring entrance at frame 15
  const titleProgress = spring({
    frame: frame - 15,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const titleOpacity = titleProgress;
  const titleTranslateY = interpolate(titleProgress, [0, 1], [30, 0]);

  // Subtitle spring entrance at frame 30
  const subtitleProgress = spring({
    frame: frame - 30,
    fps,
    config: { damping: 12, mass: 0.5 },
  });
  const subtitleOpacity = subtitleProgress;
  const subtitleTranslateY = interpolate(subtitleProgress, [0, 1], [20, 0]);

  // Link entries
  const links: LinkEntry[] = [
    { text: 'github.com/costajohnt/oss-autopilot', color: colors.blue },
    { text: 'npm install -g @oss-autopilot/core', color: colors.green },
    { text: 'npx @oss-autopilot/mcp', color: colors.purple },
  ];

  // Atmospheric background pulse — gentle opacity oscillation
  const atmospherePulse = interpolate(Math.sin((frame / 90) * Math.PI * 2), [-1, 1], [0.5, 1.0]);

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
      {/* Atmospheric gradient overlay with pulsing opacity */}
      <div style={{ ...atmosphericBackground, opacity: atmospherePulse }} />

      {/* Logo with floating/breathing animation */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          transform: `translateY(${breathY}px)`,
          marginBottom: sectionGap,
        }}
      >
        <AnimatedLogo size={logoSize} startFrame={0} stagger={1} />
      </div>

      {/* Title: "OSS Autopilot 1.0" */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: titleOpacity,
          transform: `translateY(${titleTranslateY}px)`,
          marginBottom: isSquare ? 10 : 16,
        }}
      >
        <GradientText
          fontSize={titleFontSize}
          fontWeight={fontWeights.title}
          from={colors.textPrimary}
          to={colors.purple}
        >
          OSS Autopilot 1.0
        </GradientText>
      </div>

      {/* Subtitle */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: subtitleOpacity,
          transform: `translateY(${subtitleTranslateY}px)`,
          marginBottom: isSquare ? 28 : 44,
        }}
      >
        <span
          style={{
            fontFamily: fonts.body,
            fontSize: subtitleFontSize,
            fontWeight: fontWeights.subtitle,
            color: colors.textSecondary,
          }}
        >
          Open source contributions. Managed.
        </span>
      </div>

      {/* Three links with staggered spring animations */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: isSquare ? 12 : 16,
          alignItems: 'center',
        }}
      >
        {links.map((link, i) => {
          const linkStartFrame = 50 + i * 10;
          const linkProgress = spring({
            frame: frame - linkStartFrame,
            fps,
            config: { damping: 12, mass: 0.5 },
          });
          const linkOpacity = linkProgress;
          const linkTranslateY = interpolate(linkProgress, [0, 1], [24, 0]);

          return (
            <div
              key={link.text}
              style={{
                opacity: linkOpacity,
                transform: `translateY(${linkTranslateY}px)`,
                backgroundColor: colors.surface,
                borderRadius: 12,
                borderLeft: `3px solid ${link.color}`,
                border: `1px solid ${colors.border}`,
                borderLeftWidth: 3,
                borderLeftColor: link.color,
                padding: isSquare ? '12px 28px' : '16px 36px',
                minWidth: isSquare ? 540 : 680,
                display: 'flex',
                alignItems: 'center',
                boxSizing: 'border-box',
              }}
            >
              <span
                style={{
                  fontFamily: fonts.mono,
                  fontSize: linkFontSize,
                  fontWeight: fontWeights.code,
                  color: link.color,
                }}
              >
                {link.text}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

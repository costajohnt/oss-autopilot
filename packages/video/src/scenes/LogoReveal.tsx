import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fontSizes, fontWeights, springConfig, atmosphericBackground } from '../design-tokens';
import { AnimatedLogo } from '../components/AnimatedLogo';
import { GradientText } from '../components/GradientText';
import { TypewriterText } from '../components/TypewriterText';

interface LogoRevealProps {
  format: 'landscape' | 'square';
}

export const LogoReveal: React.FC<LogoRevealProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const logoSize = isSquare ? 220 : 300;
  const titleFontSize = isSquare ? 52 : fontSizes.title;
  const subtitleFontSize = isSquare ? 32 : fontSizes.subtitle;

  // Title fade/slide in starting at frame 80
  const titleProgress = spring({
    frame: frame - 80,
    fps,
    config: springConfig.default,
  });

  const titleOpacity = titleProgress;
  const titleTranslateY = interpolate(titleProgress, [0, 1], [30, 0]);

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

      {/* Logo — AnimatedLogo handles its own per-facet animation */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          marginBottom: isSquare ? 32 : 48,
        }}
      >
        <AnimatedLogo size={logoSize} startFrame={10} />
      </div>

      {/* Title: "OSS Autopilot" in gradient text */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: titleOpacity,
          transform: `translateY(${titleTranslateY}px)`,
          marginBottom: isSquare ? 20 : 28,
        }}
      >
        <GradientText
          fontSize={titleFontSize}
          fontWeight={fontWeights.title}
          from={colors.textPrimary}
          to={colors.purple}
        >
          OSS Autopilot
        </GradientText>
      </div>

      {/* Subtitle typewriter */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: frame >= 110 ? 1 : 0,
        }}
      >
        <TypewriterText
          text="Your open source contributions. On autopilot."
          startFrame={110}
          speed={2}
          cursorColor={colors.purple}
          style={{
            fontSize: subtitleFontSize,
            fontWeight: fontWeights.subtitle,
            color: colors.textSecondary,
          }}
        />
      </div>
    </div>
  );
};

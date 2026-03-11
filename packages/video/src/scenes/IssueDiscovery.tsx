import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontSizes, fontWeights, springConfig, atmosphericBackground } from '../design-tokens';
import { SearchLane } from '../components/SearchLane';

interface IssueDiscoveryProps {
  format: 'landscape' | 'square';
}

const ISSUE_CARDS = [
  {
    score: 92,
    color: colors.green,
    title: 'Fix: race condition in WebSocket reconnect',
    repo: 'fastify/fastify',
    frameOffset: 0,
  },
  {
    score: 87,
    color: colors.green,
    title: 'Add retry logic to HTTP client middleware',
    repo: 'honojs/hono',
    frameOffset: 8,
  },
  {
    score: 78,
    color: colors.amber,
    title: 'Docs: clarify streaming response examples',
    repo: 'trpc/trpc',
    frameOffset: 16,
  },
];

export const IssueDiscovery: React.FC<IssueDiscoveryProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const laneWidth = isSquare ? 260 : 400;

  // Funnel appearance
  const funnelScale = spring({
    frame: frame - 100,
    fps,
    config: springConfig.default,
  });

  const funnelLabelOpacity = interpolate(frame - 115, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Funnel SVG dimensions
  const funnelTopWidth = isSquare ? 340 : 480;
  const funnelBottomWidth = isSquare ? 140 : 200;
  const funnelHeight = isSquare ? 60 : 80;
  const funnelSvgWidth = funnelTopWidth + 20;
  const funnelSvgHeight = funnelHeight + 4;
  const funnelCenterX = funnelSvgWidth / 2;
  const funnelTopHalf = funnelTopWidth / 2;
  const funnelBottomHalf = funnelBottomWidth / 2;

  const funnelPath = `M${funnelCenterX - funnelTopHalf} 2 L${funnelCenterX + funnelTopHalf} 2 L${funnelCenterX + funnelBottomHalf} ${funnelSvgHeight - 2} L${funnelCenterX - funnelBottomHalf} ${funnelSvgHeight - 2} Z`;

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
      <div style={atmosphericBackground} />

      {/* Section title */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: interpolate(frame, [0, 15], [0, 1], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          }),
          transform: `translateY(${interpolate(frame, [0, 15], [20, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })}px)`,
          marginBottom: isSquare ? 28 : 40,
        }}
      >
        <span
          style={{
            fontFamily: fonts.body,
            fontSize: isSquare ? fontSizes.subtitle : fontSizes.title,
            fontWeight: fontWeights.title,
            color: colors.textPrimary,
          }}
        >
          Smart Issue Discovery
        </span>
      </div>

      {/* Search lanes */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: isSquare ? 16 : 20,
          marginBottom: isSquare ? 24 : 32,
        }}
      >
        <SearchLane label="Your Starred Repos" color={colors.green} startFrame={15} duration={60} width={laneWidth} />
        <SearchLane
          label="Filtered GitHub Search"
          color={colors.blue}
          startFrame={30}
          duration={60}
          width={laneWidth}
        />
        <SearchLane label="Trending Projects" color={colors.purple} startFrame={45} duration={60} width={laneWidth} />
      </div>

      {/* Funnel visualization */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          opacity: funnelScale,
          transform: `scaleY(${funnelScale})`,
          transformOrigin: 'top center',
          marginBottom: isSquare ? 20 : 28,
        }}
      >
        <svg width={funnelSvgWidth} height={funnelSvgHeight} viewBox={`0 0 ${funnelSvgWidth} ${funnelSvgHeight}`}>
          <defs>
            <linearGradient id="funnelGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.purple} stopOpacity={0.25} />
              <stop offset="100%" stopColor={colors.purple} stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <path d={funnelPath} fill="url(#funnelGrad)" stroke={colors.purple} strokeWidth={1.5} strokeOpacity={0.5} />
        </svg>
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            opacity: funnelLabelOpacity,
          }}
        >
          <span
            style={{
              fontFamily: fonts.mono,
              fontSize: isSquare ? fontSizes.small : fontSizes.label,
              fontWeight: fontWeights.label,
              color: colors.purple,
              letterSpacing: 1,
            }}
          >
            Viability Scoring
          </span>
        </div>
      </div>

      {/* Issue cards */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: isSquare ? 'column' : 'row',
          gap: isSquare ? 12 : 20,
          alignItems: 'center',
        }}
      >
        {ISSUE_CARDS.map((card) => {
          const cardProgress = spring({
            frame: frame - (160 + card.frameOffset),
            fps,
            config: springConfig.default,
          });

          const cardTranslateY = interpolate(cardProgress, [0, 1], [40, 0]);

          return (
            <div
              key={card.score}
              style={{
                opacity: cardProgress,
                transform: `translateY(${cardTranslateY}px)`,
                background: colors.elevated,
                border: `1px solid ${colors.border}`,
                borderRadius: 12,
                padding: isSquare ? '12px 16px' : '16px 24px',
                display: 'flex',
                alignItems: 'center',
                gap: isSquare ? 12 : 16,
                minWidth: isSquare ? 320 : 280,
              }}
            >
              {/* Score badge */}
              <div
                style={{
                  width: isSquare ? 44 : 52,
                  height: isSquare ? 44 : 52,
                  borderRadius: 10,
                  background: `${card.color}18`,
                  border: `1.5px solid ${card.color}50`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: isSquare ? fontSizes.small : fontSizes.label,
                    fontWeight: 700,
                    color: card.color,
                  }}
                >
                  {card.score}
                </span>
              </div>

              {/* Issue info */}
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                <span
                  style={{
                    fontFamily: fonts.body,
                    fontSize: isSquare ? fontSizes.small - 2 : fontSizes.small,
                    fontWeight: fontWeights.body,
                    color: colors.textPrimary,
                    lineHeight: 1.3,
                  }}
                >
                  {card.title}
                </span>
                <span
                  style={{
                    fontFamily: fonts.mono,
                    fontSize: isSquare ? fontSizes.small - 6 : fontSizes.small - 4,
                    color: colors.textMuted,
                  }}
                >
                  {card.repo}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontSizes, fontWeights, springConfig, atmosphericBackground } from '../design-tokens';
import { AgentIcon } from '../components/AgentIcon';

interface AgentArmyProps {
  format: 'landscape' | 'square';
}

interface AgentDef {
  name: string;
  description: string;
  color: string;
  startFrame: number;
}

const AGENTS: AgentDef[] = [
  {
    name: 'pr-responder',
    description: 'Drafts PR responses',
    color: colors.blue,
    startFrame: 15,
  },
  {
    name: 'pr-health-checker',
    description: 'Monitors CI & reviews',
    color: colors.green,
    startFrame: 25,
  },
  {
    name: 'issue-scout',
    description: 'Finds new issues',
    color: colors.purple,
    startFrame: 35,
  },
  {
    name: 'repo-evaluator',
    description: 'Evaluates repositories',
    color: colors.amber,
    startFrame: 45,
  },
  {
    name: 'contribution-strategist',
    description: 'Plans contributions',
    color: colors.red,
    startFrame: 55,
  },
  {
    name: 'pr-compliance-checker',
    description: 'Checks PR guidelines',
    color: colors.blue,
    startFrame: 65,
  },
  {
    name: 'pre-commit-reviewer',
    description: 'Reviews before commit',
    color: colors.green,
    startFrame: 75,
  },
];

// Grid positions for each format
function getGridPositions(isSquare: boolean, iconSize: number, gapX: number, gapY: number): { x: number; y: number }[] {
  const cellW = iconSize + gapX;
  const cellH = iconSize + gapY + 40; // extra space for label + description

  if (isSquare) {
    // 3-row layout: 3-2-2
    const rows = [3, 2, 2];
    const positions: { x: number; y: number }[] = [];
    let agentIdx = 0;
    for (let r = 0; r < rows.length; r++) {
      const count = rows[r];
      const rowWidth = count * cellW - gapX;
      const startX = -rowWidth / 2 + iconSize / 2;
      for (let c = 0; c < count; c++) {
        if (agentIdx >= 7) break;
        positions.push({
          x: startX + c * cellW,
          y: (r - 1) * cellH, // center row 1 at y=0
        });
        agentIdx++;
      }
    }
    return positions;
  }

  // Landscape: 2-row layout: 4-3
  const rows = [4, 3];
  const positions: { x: number; y: number }[] = [];
  let agentIdx = 0;
  for (let r = 0; r < rows.length; r++) {
    const count = rows[r];
    const rowWidth = count * cellW - gapX;
    const startX = -rowWidth / 2 + iconSize / 2;
    for (let c = 0; c < count; c++) {
      if (agentIdx >= 7) break;
      positions.push({
        x: startX + c * cellW,
        y: (r === 0 ? -1 : 1) * (cellH / 2),
      });
      agentIdx++;
    }
  }
  return positions;
}

// Define network connections (pairs of agent indices)
const CONNECTIONS: [number, number][] = [
  [0, 1],
  [0, 3],
  [1, 2],
  [1, 4],
  [2, 3],
  [2, 6],
  [3, 5],
  [4, 5],
  [4, 6],
  [5, 6],
];

export const AgentArmy: React.FC<AgentArmyProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const isSquare = format === 'square';
  const iconSize = isSquare ? 64 : 80;
  const gapX = isSquare ? 60 : 80;
  const gapY = isSquare ? 16 : 20;

  const positions = getGridPositions(isSquare, iconSize, gapX, gapY);

  // Title animation
  const titleProgress = spring({
    frame,
    fps,
    config: springConfig.default,
  });

  // Compute SVG viewBox from positions
  const padding = 40;
  const allX = positions.map((p) => p.x);
  const allY = positions.map((p) => p.y);
  const minX = Math.min(...allX) - iconSize / 2 - padding;
  const maxX = Math.max(...allX) + iconSize / 2 + padding;
  const minY = Math.min(...allY) - iconSize / 2 - padding;
  const maxY = Math.max(...allY) + iconSize / 2 + padding;
  const svgWidth = maxX - minX;
  const svgHeight = maxY - minY;

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

      {/* Title */}
      <div
        style={{
          position: 'relative',
          zIndex: 2,
          opacity: titleProgress,
          transform: `translateY(${interpolate(titleProgress, [0, 1], [20, 0])}px)`,
          marginBottom: isSquare ? 20 : 32,
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
          The Agent Army
        </span>
      </div>

      {/* Agent grid + network lines container */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: svgWidth,
          height: svgHeight,
        }}
      >
        {/* Network connection lines (SVG underlay) */}
        <svg
          width={svgWidth}
          height={svgHeight}
          viewBox={`${minX} ${minY} ${svgWidth} ${svgHeight}`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
          }}
        >
          {CONNECTIONS.map(([fromIdx, toIdx]) => {
            const from = positions[fromIdx];
            const to = positions[toIdx];
            const dx = to.x - from.x;
            const dy = to.y - from.y;
            const length = Math.sqrt(dx * dx + dy * dy);

            // Each line starts drawing staggered within the 120-160 range
            const lineOffset = (fromIdx + toIdx) / (AGENTS.length * 2);
            const thisLineProgress = interpolate(frame, [120 + lineOffset * 20, 155 + lineOffset * 5], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            });

            return (
              <line
                key={`${fromIdx}-${toIdx}`}
                x1={from.x}
                y1={from.y}
                x2={to.x}
                y2={to.y}
                stroke={colors.border}
                strokeWidth={1.5}
                strokeDasharray={length}
                strokeDashoffset={length * (1 - thisLineProgress)}
                opacity={thisLineProgress * 0.7}
              />
            );
          })}
        </svg>

        {/* Agent icons (positioned absolutely within the container) */}
        {AGENTS.map((agent, idx) => {
          const pos = positions[idx];
          return (
            <div
              key={agent.name}
              style={{
                position: 'absolute',
                left: pos.x - minX - iconSize / 2,
                top: pos.y - minY - iconSize / 2,
                // Offset to center the AgentIcon component (which includes label/desc below)
                transform: 'translate(-20px, -20px)',
              }}
            >
              <AgentIcon
                name={agent.name}
                description={agent.description}
                color={agent.color}
                startFrame={agent.startFrame}
                size={iconSize}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

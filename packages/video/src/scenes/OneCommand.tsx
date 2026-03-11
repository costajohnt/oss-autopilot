import React from 'react';
import { useCurrentFrame, spring, useVideoConfig } from 'remotion';
import { colors, fonts, fontSizes, atmosphericBackground } from '../design-tokens';
import { TerminalWindow } from '../components/TerminalWindow';
import { TypewriterText } from '../components/TypewriterText';
import { FeatureCallout } from '../components/FeatureCallout';

interface OneCommandProps {
  format: 'landscape' | 'square';
}

const JSON_LINES = [
  '{',
  '  "success": true,',
  '  "data": {',
  '    "activePRs": 12,',
  '    "needAttention": 3,',
  '    "waitingOnMaintainer": 9,',
  '    "mergedThisMonth": 7',
  '  }',
  '}',
];

const JSON_START_FRAME = 60;
const JSON_LINE_STAGGER = 4;

const CALLOUTS = [
  { text: 'Fetches all PRs', color: colors.blue, startFrame: 80 },
  { text: 'Computes status', color: colors.green, startFrame: 100 },
  { text: 'Recommends actions', color: colors.amber, startFrame: 120 },
] as const;

/** Scene 3: One Command — 180 frames (6s at 30 fps) */
export const OneCommand: React.FC<OneCommandProps> = ({ format }) => {
  const { fps } = useVideoConfig();
  const isSquare = format === 'square';

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        backgroundColor: colors.base,
        display: 'flex',
        flexDirection: isSquare ? 'column' : 'row',
        alignItems: isSquare ? 'stretch' : 'center',
        justifyContent: 'center',
        position: 'relative',
        overflow: 'hidden',
        padding: isSquare ? 48 : 80,
        gap: isSquare ? 36 : 60,
      }}
    >
      {/* Atmospheric gradient overlay */}
      <div style={atmosphericBackground} />

      {/* Terminal panel */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          flex: isSquare ? '1 1 auto' : '0 0 58%',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <TerminalWindow title="oss-autopilot">
          {/* Command prompt with typewriter */}
          <div style={{ marginBottom: 16 }}>
            <span style={{ color: colors.green, marginRight: 8 }}>$</span>
            <TypewriterText
              text="oss-autopilot daily --json"
              startFrame={5}
              speed={1.5}
              cursorColor={colors.green}
              mono
              style={{ fontSize: fontSizes.code }}
            />
          </div>

          {/* JSON output lines appearing one by one */}
          <div style={{ marginTop: 8 }}>
            {JSON_LINES.map((line, i) => {
              const lineStartFrame = JSON_START_FRAME + i * JSON_LINE_STAGGER;
              return <JsonLine key={i} text={line} startFrame={lineStartFrame} fps={fps} />;
            })}
          </div>
        </TerminalWindow>
      </div>

      {/* Callouts panel */}
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          flex: isSquare ? '0 0 auto' : '0 0 34%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'center',
          gap: isSquare ? 24 : 40,
        }}
      >
        {CALLOUTS.map((callout, i) => (
          <FeatureCallout
            key={i}
            text={callout.text}
            color={callout.color}
            startFrame={callout.startFrame}
            style={{
              position: 'relative',
              fontSize: isSquare ? fontSizes.small : fontSizes.label,
            }}
          />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Internal component: a single JSON line that fades/springs in      */
/* ------------------------------------------------------------------ */

interface JsonLineProps {
  text: string;
  startFrame: number;
  fps: number;
}

const JsonLine: React.FC<JsonLineProps> = ({ text, startFrame, fps }) => {
  const frame = useCurrentFrame();

  const progress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 14, mass: 0.4 },
  });

  // Syntax-colour JSON keys and values
  const coloured = colouriseJson(text);

  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${(1 - progress) * 10}px)`,
        lineHeight: 1.7,
        fontFamily: fonts.mono,
        fontSize: fontSizes.code,
        whiteSpace: 'pre',
      }}
    >
      {coloured}
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Tiny JSON syntax highlighter                                      */
/* ------------------------------------------------------------------ */

function colouriseJson(line: string): React.ReactNode {
  const keyMatch = line.match(/^(\s*)"([^"]+)"(\s*:\s*)(.*)/);
  if (!keyMatch) {
    return <span style={{ color: colors.textMuted }}>{line}</span>;
  }

  const [, indent, keyText, colon, value] = keyMatch;

  const colourValue = (val: string): React.ReactNode => {
    const numMatch = val.match(/^(\d+)(,?)$/);
    if (numMatch) {
      return (
        <>
          <span style={{ color: colors.amber }}>{numMatch[1]}</span>
          {numMatch[2] && <span style={{ color: colors.textMuted }}>{numMatch[2]}</span>}
        </>
      );
    }
    const strMatch = val.match(/^(".*?")(,?)$/);
    if (strMatch) {
      return (
        <>
          <span style={{ color: colors.green }}>{strMatch[1]}</span>
          {strMatch[2] && <span style={{ color: colors.textMuted }}>{strMatch[2]}</span>}
        </>
      );
    }
    const boolMatch = val.match(/^(true|false)(,?)$/);
    if (boolMatch) {
      return (
        <>
          <span style={{ color: colors.green }}>{boolMatch[1]}</span>
          {boolMatch[2] && <span style={{ color: colors.textMuted }}>{boolMatch[2]}</span>}
        </>
      );
    }
    const objMatch = val.match(/^([{}[\]])(,?)$/);
    if (objMatch) {
      return (
        <>
          <span style={{ color: colors.textPrimary }}>{objMatch[1]}</span>
          {objMatch[2] && <span style={{ color: colors.textMuted }}>{objMatch[2]}</span>}
        </>
      );
    }
    return <span style={{ color: colors.textPrimary }}>{val}</span>;
  };

  return (
    <>
      <span style={{ color: colors.textMuted }}>{indent}</span>
      <span style={{ color: colors.blue }}>&quot;{keyText}&quot;</span>
      <span style={{ color: colors.textMuted }}>{colon}</span>
      {colourValue(value)}
    </>
  );
}

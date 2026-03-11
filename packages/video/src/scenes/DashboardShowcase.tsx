import React from 'react';
import { useCurrentFrame, spring, useVideoConfig, interpolate } from 'remotion';
import { colors, fonts, fontSizes, fontWeights, springConfig, atmosphericBackground } from '../design-tokens';
import { FeatureCallout } from '../components/FeatureCallout';

interface DashboardShowcaseProps {
  format: 'landscape' | 'square';
}

/**
 * A dashboard "phase" describes the zoom/pan target and its timing.
 * The ScreenRecording component interpolates between the *previous* state
 * and the current one, so we list them in sequence.
 */
interface Phase {
  startFrame: number;
  endFrame: number;
  zoom: number;
  panX: number;
  panY: number;
}

const PHASES: Phase[] = [
  { startFrame: 0, endFrame: 60, zoom: 1, panX: 0, panY: 0 },
  { startFrame: 60, endFrame: 150, zoom: 1.8, panX: 0, panY: -0.2 },
  { startFrame: 150, endFrame: 240, zoom: 1.5, panX: -0.15, panY: 0 },
  { startFrame: 240, endFrame: 360, zoom: 1.6, panX: 0, panY: 0.2 },
  { startFrame: 360, endFrame: 420, zoom: 1, panX: 0, panY: 0 },
  { startFrame: 420, endFrame: 450, zoom: 1, panX: 0, panY: 0 },
];

const CALLOUTS = [
  { text: 'Stats at a glance', color: colors.green, startFrame: 30 },
  { text: 'Color-coded PR sections', color: colors.blue, startFrame: 120 },
  { text: 'CI status & reviews', color: colors.purple, startFrame: 200 },
  { text: 'Monthly trends & charts', color: colors.amber, startFrame: 280 },
] as const;

/** Scene 4: Dashboard Showcase -- 450 frames (15s at 30 fps) */
export const DashboardShowcase: React.FC<DashboardShowcaseProps> = ({ format }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const isSquare = format === 'square';

  // Bump zoom slightly for square to compensate for lost horizontal space
  const zoomBoost = isSquare ? 0.15 : 0;

  // Compute current zoom/pan by interpolating across phases
  const { zoom, panX, panY } = computeCurrentTransform(frame, PHASES, zoomBoost);

  // Callout positioning: stagger vertically on the right (or bottom for square)
  const calloutBaseX = isSquare ? 60 : 1340;
  const calloutBaseY = isSquare ? 780 : 200;
  const calloutSpacingY = isSquare ? 56 : 80;

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

      {/* Scene title — brief fade in at start */}
      <SceneTitle frame={frame} fps={fps} isSquare={isSquare} />

      {/* Dashboard recording (placeholder) with animated zoom/pan */}
      <div
        style={{
          position: 'absolute',
          top: isSquare ? 80 : 60,
          left: isSquare ? 40 : 60,
          width: isSquare ? 'calc(100% - 80px)' : 'calc(100% - 120px)',
          height: isSquare ? '65%' : 'calc(100% - 120px)',
          zIndex: 1,
        }}
      >
        <AnimatedRecording zoom={zoom} panX={panX} panY={panY} />
      </div>

      {/* Feature callouts overlay */}
      <div style={{ position: 'absolute', inset: 0, zIndex: 2 }}>
        {CALLOUTS.map((callout, i) => (
          <FeatureCallout
            key={i}
            text={callout.text}
            color={callout.color}
            startFrame={callout.startFrame}
            x={calloutBaseX}
            y={calloutBaseY + i * calloutSpacingY}
          />
        ))}
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Animated screen recording wrapper                                  */
/* ------------------------------------------------------------------ */

interface AnimatedRecordingProps {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Instead of passing animated zoom/pan through ScreenRecording's
 * frame-range-based interpolation, we apply the transform directly
 * and use ScreenRecording in its static placeholder mode.
 */
const AnimatedRecording: React.FC<AnimatedRecordingProps> = ({ zoom, panX, panY }) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      overflow: 'hidden',
      borderRadius: 12,
      border: `1px solid ${colors.border}`,
      boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
    }}
  >
    <div
      style={{
        width: '100%',
        height: '100%',
        background: `linear-gradient(135deg, ${colors.surface}, ${colors.elevated})`,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        transform: `scale(${zoom}) translate(${-panX * 100}%, ${-panY * 100}%)`,
        transformOrigin: 'center center',
      }}
    >
      {/* Mock dashboard skeleton elements */}
      <DashboardPlaceholder />
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Dashboard placeholder (skeleton UI)                                */
/* ------------------------------------------------------------------ */

const DashboardPlaceholder: React.FC = () => (
  <div
    style={{
      width: '85%',
      height: '80%',
      display: 'flex',
      flexDirection: 'column',
      gap: 16,
    }}
  >
    {/* Top stats row */}
    <div style={{ display: 'flex', gap: 16, flex: '0 0 80px' }}>
      {[colors.green, colors.blue, colors.purple, colors.amber].map((color, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            background: `linear-gradient(135deg, ${color}15, ${color}08)`,
            border: `1px solid ${color}30`,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              width: 32,
              height: 8,
              borderRadius: 4,
              background: `${color}60`,
            }}
          />
        </div>
      ))}
    </div>

    {/* Main content area */}
    <div style={{ display: 'flex', gap: 16, flex: 1 }}>
      {/* PR list */}
      <div
        style={{
          flex: 2,
          background: colors.surface,
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: 28,
              borderRadius: 6,
              background: `rgba(255,255,255,${0.04 - i * 0.005})`,
            }}
          />
        ))}
      </div>

      {/* Charts panel */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <div
          style={{
            flex: 1,
            background: colors.surface,
            borderRadius: 10,
            border: `1px solid ${colors.border}`,
          }}
        />
        <div
          style={{
            flex: 1,
            background: colors.surface,
            borderRadius: 10,
            border: `1px solid ${colors.border}`,
          }}
        />
      </div>
    </div>
  </div>
);

/* ------------------------------------------------------------------ */
/*  Scene title (fades out after initial hold)                         */
/* ------------------------------------------------------------------ */

interface SceneTitleProps {
  frame: number;
  fps: number;
  isSquare: boolean;
}

const SceneTitle: React.FC<SceneTitleProps> = ({ frame, fps, isSquare }) => {
  const titleIn = spring({
    frame: frame - 5,
    fps,
    config: springConfig.default,
  });

  const titleOut = interpolate(frame, [45, 60], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const opacity = Math.min(titleIn, titleOut);

  return (
    <div
      style={{
        position: 'absolute',
        top: isSquare ? 20 : 16,
        left: 0,
        width: '100%',
        textAlign: 'center',
        zIndex: 3,
        opacity,
        transform: `translateY(${(1 - titleIn) * 20}px)`,
      }}
    >
      <span
        style={{
          fontFamily: fonts.body,
          fontSize: isSquare ? fontSizes.body : fontSizes.subtitle,
          fontWeight: fontWeights.subtitle,
          color: colors.textSecondary,
          background: colors.elevated,
          padding: '8px 24px',
          borderRadius: 10,
          border: `1px solid ${colors.border}`,
        }}
      >
        Interactive Dashboard
      </span>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/*  Transform computation: smooth interpolation between phases         */
/* ------------------------------------------------------------------ */

function computeCurrentTransform(
  frame: number,
  phases: Phase[],
  zoomBoost: number,
): { zoom: number; panX: number; panY: number } {
  // Find which phase transition we're in
  for (let i = 1; i < phases.length; i++) {
    const prev = phases[i - 1];
    const curr = phases[i];

    if (frame < curr.startFrame) {
      // We're still in `prev` phase (held state)
      return {
        zoom: prev.zoom + zoomBoost * (prev.zoom > 1 ? 1 : 0),
        panX: prev.panX,
        panY: prev.panY,
      };
    }

    const transitionDuration = 30; // 1 second transition between phases
    const transitionEnd = curr.startFrame + transitionDuration;

    if (frame >= curr.startFrame && frame < transitionEnd) {
      // Transitioning from prev to curr
      const t = interpolate(frame, [curr.startFrame, transitionEnd], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      });

      // Smooth ease-out
      const eased = 1 - Math.pow(1 - t, 3);

      const prevZoom = prev.zoom + zoomBoost * (prev.zoom > 1 ? 1 : 0);
      const currZoom = curr.zoom + zoomBoost * (curr.zoom > 1 ? 1 : 0);

      return {
        zoom: prevZoom + (currZoom - prevZoom) * eased,
        panX: prev.panX + (curr.panX - prev.panX) * eased,
        panY: prev.panY + (curr.panY - prev.panY) * eased,
      };
    }
  }

  // Past all phases — hold the last state
  const last = phases[phases.length - 1];
  return {
    zoom: last.zoom + zoomBoost * (last.zoom > 1 ? 1 : 0),
    panX: last.panX,
    panY: last.panY,
  };
}

import React from 'react';
import { useCurrentFrame, interpolate, OffthreadVideo, staticFile } from 'remotion';
import { colors } from '../design-tokens';

interface ScreenRecordingProps {
  /** Path relative to public/ or absolute */
  src?: string;
  /** Zoom level (1 = no zoom) */
  zoom?: number;
  /** Pan offset as fraction of width (0-1) */
  panX?: number;
  /** Pan offset as fraction of height (0-1) */
  panY?: number;
  /** Start zoom frame */
  zoomStartFrame?: number;
  /** Zoom duration in frames */
  zoomDuration?: number;
  style?: React.CSSProperties;
}

/**
 * Wraps a screen recording video or a placeholder rectangle
 * with zoom/pan overlays.
 */
export const ScreenRecording: React.FC<ScreenRecordingProps> = ({
  src,
  zoom = 1,
  panX = 0,
  panY = 0,
  zoomStartFrame = 0,
  zoomDuration = 30,
  style,
}) => {
  const frame = useCurrentFrame();

  const currentZoom = interpolate(frame, [zoomStartFrame, zoomStartFrame + zoomDuration], [1, zoom], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const currentPanX = interpolate(frame, [zoomStartFrame, zoomStartFrame + zoomDuration], [0, panX * 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const currentPanY = interpolate(frame, [zoomStartFrame, zoomStartFrame + zoomDuration], [0, panY * 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        borderRadius: 12,
        border: `1px solid ${colors.border}`,
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
        ...style,
      }}
    >
      {src ? (
        <OffthreadVideo
          src={staticFile(src)}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            transform: `scale(${currentZoom}) translate(${-currentPanX}%, ${-currentPanY}%)`,
          }}
        />
      ) : (
        /* Placeholder when no recording is available */
        <div
          style={{
            width: '100%',
            height: '100%',
            background: `linear-gradient(135deg, ${colors.surface}, ${colors.elevated})`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transform: `scale(${currentZoom}) translate(${-currentPanX}%, ${-currentPanY}%)`,
          }}
        >
          <span
            style={{
              color: colors.textMuted,
              fontSize: 28,
              fontFamily: "'Plus Jakarta Sans', sans-serif",
            }}
          >
            Screen recording placeholder
          </span>
        </div>
      )}
    </div>
  );
};

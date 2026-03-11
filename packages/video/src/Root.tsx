import React from 'react';
import { Composition } from 'remotion';
import { Video } from './Video';

const FPS = 30;
const TOTAL_FRAMES = 2100; // ~70 seconds

export const Root: React.FC = () => (
  <>
    <Composition
      id="OSSAutopilot1080p"
      component={Video}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1920}
      height={1080}
      defaultProps={{ format: 'landscape' as const }}
    />
    <Composition
      id="OSSAutopilotSquare"
      component={Video}
      durationInFrames={TOTAL_FRAMES}
      fps={FPS}
      width={1080}
      height={1080}
      defaultProps={{ format: 'square' as const }}
    />
  </>
);

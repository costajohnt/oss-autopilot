import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, interpolate } from 'remotion';
import { colors, atmosphericBackground } from './design-tokens';
import { LogoReveal } from './scenes/LogoReveal';
import { TheProblem } from './scenes/TheProblem';
import { OneCommand } from './scenes/OneCommand';
import { DashboardShowcase } from './scenes/DashboardShowcase';
import { IssueDiscovery } from './scenes/IssueDiscovery';
import { AgentArmy } from './scenes/AgentArmy';
import { ThreeWaysToRun } from './scenes/ThreeWaysToRun';
import { CallToAction } from './scenes/CallToAction';

export type VideoFormat = 'landscape' | 'square';

export interface VideoProps {
  format?: VideoFormat;
}

/**
 * Scene timings (frames at 30fps):
 *
 * Scene 1: Logo Reveal      0-210   (7s)
 * Scene 2: The Problem     210-420  (7s)
 * Scene 3: One Command     420-600  (6s)
 * Scene 4: Dashboard       600-1050 (15s)
 * Scene 5: Issue Discovery 1050-1350 (10s)
 * Scene 6: Agent Army      1350-1650 (10s)
 * Scene 7: Three Ways      1650-1890 (8s)
 * Scene 8: Call to Action  1890-2100 (7s)
 */
const SCENES = [
  { start: 0, duration: 210 },
  { start: 210, duration: 210 },
  { start: 420, duration: 180 },
  { start: 600, duration: 450 },
  { start: 1050, duration: 300 },
  { start: 1350, duration: 300 },
  { start: 1650, duration: 240 },
  { start: 1890, duration: 210 },
] as const;

/** Cross-fade transition: overlaps last `overlap` frames of prev scene with first of next */
const OVERLAP = 15;

export const Video: React.FC<VideoProps> = ({ format = 'landscape' }) => {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ backgroundColor: colors.base }}>
      {/* Atmospheric background */}
      <div style={atmosphericBackground} />

      {/* Scene 1: Logo Reveal */}
      <Sequence from={SCENES[0].start} durationInFrames={SCENES[0].duration}>
        <SceneFade sceneFrame={frame - SCENES[0].start} duration={SCENES[0].duration}>
          <LogoReveal format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 2: The Problem */}
      <Sequence from={SCENES[1].start - OVERLAP} durationInFrames={SCENES[1].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[1].start + OVERLAP} duration={SCENES[1].duration + OVERLAP}>
          <TheProblem format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 3: One Command */}
      <Sequence from={SCENES[2].start - OVERLAP} durationInFrames={SCENES[2].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[2].start + OVERLAP} duration={SCENES[2].duration + OVERLAP}>
          <OneCommand format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 4: Dashboard Showcase */}
      <Sequence from={SCENES[3].start - OVERLAP} durationInFrames={SCENES[3].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[3].start + OVERLAP} duration={SCENES[3].duration + OVERLAP}>
          <DashboardShowcase format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 5: Issue Discovery */}
      <Sequence from={SCENES[4].start - OVERLAP} durationInFrames={SCENES[4].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[4].start + OVERLAP} duration={SCENES[4].duration + OVERLAP}>
          <IssueDiscovery format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 6: Agent Army */}
      <Sequence from={SCENES[5].start - OVERLAP} durationInFrames={SCENES[5].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[5].start + OVERLAP} duration={SCENES[5].duration + OVERLAP}>
          <AgentArmy format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 7: Three Ways to Run */}
      <Sequence from={SCENES[6].start - OVERLAP} durationInFrames={SCENES[6].duration + OVERLAP}>
        <SceneFade sceneFrame={frame - SCENES[6].start + OVERLAP} duration={SCENES[6].duration + OVERLAP}>
          <ThreeWaysToRun format={format} />
        </SceneFade>
      </Sequence>

      {/* Scene 8: Call to Action */}
      <Sequence from={SCENES[7].start - OVERLAP} durationInFrames={SCENES[7].duration + OVERLAP}>
        <SceneFade
          sceneFrame={frame - SCENES[7].start + OVERLAP}
          duration={SCENES[7].duration + OVERLAP}
          fadeOut={false}
        >
          <CallToAction format={format} />
        </SceneFade>
      </Sequence>
    </AbsoluteFill>
  );
};

/** Wraps a scene with fade-in / fade-out transitions */
const SceneFade: React.FC<{
  children: React.ReactNode;
  sceneFrame: number;
  duration: number;
  fadeIn?: boolean;
  fadeOut?: boolean;
}> = ({ children, sceneFrame, duration, fadeIn = true, fadeOut = true }) => {
  const fadeInOpacity = fadeIn
    ? interpolate(sceneFrame, [0, OVERLAP], [0, 1], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  const fadeOutOpacity = fadeOut
    ? interpolate(sceneFrame, [duration - OVERLAP, duration], [1, 0], {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
      })
    : 1;

  return <AbsoluteFill style={{ opacity: fadeInOpacity * fadeOutOpacity }}>{children}</AbsoluteFill>;
};

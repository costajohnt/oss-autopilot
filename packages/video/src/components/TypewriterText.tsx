import React from 'react';
import { useCurrentFrame } from 'remotion';
import { fonts, colors } from '../design-tokens';

interface TypewriterTextProps {
  text: string;
  startFrame?: number;
  /** Frames per character */
  speed?: number;
  style?: React.CSSProperties;
  cursorColor?: string;
  showCursor?: boolean;
  mono?: boolean;
}

export const TypewriterText: React.FC<TypewriterTextProps> = ({
  text,
  startFrame = 0,
  speed = 2,
  style,
  cursorColor = colors.blue,
  showCursor = true,
  mono = false,
}) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;
  const charsToShow = Math.min(Math.max(0, Math.floor(elapsed / speed)), text.length);
  const isComplete = charsToShow >= text.length;
  const cursorVisible = !isComplete && elapsed > 0 && frame % 16 < 10;

  return (
    <span
      style={{
        fontFamily: mono ? fonts.mono : fonts.body,
        color: colors.textPrimary,
        whiteSpace: 'pre',
        ...style,
      }}
    >
      {text.slice(0, charsToShow)}
      {showCursor && (
        <span
          style={{
            color: cursorColor,
            opacity: cursorVisible ? 1 : 0,
          }}
        >
          |
        </span>
      )}
    </span>
  );
};

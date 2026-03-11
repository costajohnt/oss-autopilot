import { useCurrentFrame } from 'remotion';

/**
 * Returns an array of progress values (0-1) for staggered child animations.
 * Each child starts `gap` frames after the previous one.
 *
 * @param count - Number of children
 * @param enterDuration - Frames each child takes to fully appear
 * @param gap - Frame delay between children (default: 5)
 * @param startFrame - Frame offset before first child begins (default: 0)
 */
export function useStagger(count: number, enterDuration: number, gap = 5, startFrame = 0): number[] {
  const frame = useCurrentFrame();
  return Array.from({ length: count }, (_, i) => {
    const childStart = startFrame + i * gap;
    const elapsed = frame - childStart;
    if (elapsed <= 0) return 0;
    if (elapsed >= enterDuration) return 1;
    return elapsed / enterDuration;
  });
}

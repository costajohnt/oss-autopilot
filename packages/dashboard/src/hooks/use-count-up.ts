import { useState, useEffect, useRef } from 'preact/hooks';

interface UseCountUpOptions {
  duration?: number;
}

export function useCountUp(target: number, options?: UseCountUpOptions): number {
  const duration = options?.duration ?? 800;
  const [value, setValue] = useState(0);
  const rafRef = useRef<number>(0);
  const startTimeRef = useRef<number>(0);
  const startValueRef = useRef(0);

  useEffect(() => {
    // Skip animation when user prefers reduced motion
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      return;
    }

    if (target === 0) {
      setValue(0);
      return;
    }

    startValueRef.current = value;
    startTimeRef.current = 0;

    const step = (timestamp: number) => {
      if (!startTimeRef.current) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);

      // ease-out cubic for a natural deceleration feel
      const eased = 1 - Math.pow(1 - progress, 3);

      const current = Math.round(startValueRef.current + (target - startValueRef.current) * eased);
      setValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(step);
      }
    };

    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}

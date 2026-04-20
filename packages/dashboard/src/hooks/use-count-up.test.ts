import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useCountUp } from './use-count-up';

describe('useCountUp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 initially when given a positive target', () => {
    const { result } = renderHook(() => useCountUp(42));
    // On the very first render, the hook starts at 0
    expect(result.current).toBe(0);
  });

  it('reaches the target value after the animation duration', () => {
    const { result } = renderHook(() => useCountUp(10, { duration: 500 }));

    // Advance past the full duration
    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current).toBe(10);
  });

  it('returns 0 immediately when target is 0', () => {
    const { result } = renderHook(() => useCountUp(0));
    expect(result.current).toBe(0);
  });

  it('always returns an integer (no decimals during animation)', () => {
    const values: number[] = [];
    renderHook(() => {
      const val = useCountUp(7, { duration: 300 });
      values.push(val);
      return val;
    });

    // Step through in small increments
    for (let i = 0; i < 20; i++) {
      act(() => {
        vi.advanceTimersByTime(20);
      });
    }

    // Every intermediate value should be an integer
    for (const v of values) {
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('updates to new target when target changes', () => {
    const { result, rerender } = renderHook(({ target }: { target: number }) => useCountUp(target, { duration: 500 }), {
      initialProps: { target: 10 },
    });

    // Complete first animation
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe(10);

    // Change target
    rerender({ target: 20 });

    // Complete second animation
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(result.current).toBe(20);
  });

  it('produces intermediate values between 0 and the target', () => {
    const values = new Set<number>();
    renderHook(() => {
      const val = useCountUp(100, { duration: 500 });
      values.add(val);
      return val;
    });

    // Step through the animation
    for (let i = 0; i < 30; i++) {
      act(() => {
        vi.advanceTimersByTime(20);
      });
    }

    // Should have values between 0 and 100 (not just 0 and 100)
    expect(values.size).toBeGreaterThan(2);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('respects prefers-reduced-motion by skipping animation', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockImplementation((query: string) => ({
        matches: query === '(prefers-reduced-motion: reduce)',
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => false),
      })),
    );

    const { result } = renderHook(() => useCountUp(42));
    // Should immediately show the final value, no animation
    expect(result.current).toBe(42);

    vi.restoreAllMocks();
  });

  it('uses default duration when none specified', () => {
    const { result } = renderHook(() => useCountUp(50));

    // Default duration is 800ms. At 200ms we should be mid-animation.
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThanOrEqual(50);

    // After full duration animation should be complete
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(result.current).toBe(50);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useCelebration } from './use-celebration';

const MERGED_COUNT_KEY = 'oss-autopilot-merged-count';
const CELEBRATIONS_KEY = 'oss-autopilot-celebrations';

describe('useCelebration', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('stores count and does not celebrate on first visit (no stored count)', () => {
    const { result } = renderHook(() => useCelebration(10));
    expect(result.current.celebrating).toBe(false);
    expect(result.current.newMergeCount).toBe(null);
    expect(localStorage.getItem(MERGED_COUNT_KEY)).toBe('10');
  });

  it('celebrates when current count exceeds stored count', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '8');
    const { result } = renderHook(() => useCelebration(11));
    expect(result.current.celebrating).toBe(true);
    expect(result.current.newMergeCount).toBe(3);
    expect(localStorage.getItem(MERGED_COUNT_KEY)).toBe('11');
  });

  it('does not celebrate when count is unchanged', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '10');
    const { result } = renderHook(() => useCelebration(10));
    expect(result.current.celebrating).toBe(false);
    expect(result.current.newMergeCount).toBe(null);
  });

  it('does not celebrate when count decreased (edge case)', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '15');
    const { result } = renderHook(() => useCelebration(12));
    expect(result.current.celebrating).toBe(false);
    expect(localStorage.getItem(MERGED_COUNT_KEY)).toBe('12');
  });

  it('does not celebrate when celebrations are disabled', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '5');
    localStorage.setItem(CELEBRATIONS_KEY, 'false');
    const { result } = renderHook(() => useCelebration(8));
    expect(result.current.celebrating).toBe(false);
    expect(localStorage.getItem(MERGED_COUNT_KEY)).toBe('8');
  });

  it('auto-dismisses after 5 seconds', async () => {
    localStorage.setItem(MERGED_COUNT_KEY, '5');
    const { result } = renderHook(() => useCelebration(7));
    expect(result.current.celebrating).toBe(true);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(result.current.celebrating).toBe(false);
  });

  it('dismiss() clears celebration immediately', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '5');
    const { result } = renderHook(() => useCelebration(7));
    expect(result.current.celebrating).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.celebrating).toBe(false);
  });

  it('does not re-trigger when mergedCount updates after initial check', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '5');
    const { result, rerender } = renderHook(({ count }) => useCelebration(count), {
      initialProps: { count: 7 },
    });
    expect(result.current.celebrating).toBe(true);

    act(() => {
      result.current.dismiss();
    });

    // Simulate auto-refresh delivering a higher count
    rerender({ count: 9 });
    expect(result.current.celebrating).toBe(false);
  });

  it('does nothing when mergedCount is undefined (data not yet loaded)', () => {
    const { result } = renderHook(() => useCelebration(undefined));
    expect(result.current.celebrating).toBe(false);
    expect(localStorage.getItem(MERGED_COUNT_KEY)).toBe(null);
  });

  it('cleans up timer on unmount', () => {
    localStorage.setItem(MERGED_COUNT_KEY, '5');
    const { result, unmount } = renderHook(() => useCelebration(7));
    expect(result.current.celebrating).toBe(true);
    unmount();
    // Should not throw — timer cleared
    vi.advanceTimersByTime(5_000);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/preact';
import { useCelebration } from './use-celebration';

const STORAGE_KEY = 'oss-autopilot-merged-count';

const confettiMock = vi.fn();
vi.mock('canvas-confetti', () => ({
  default: (...args: unknown[]) => confettiMock(...args),
}));

function mockReducedMotion(matches: boolean) {
  const mql = {
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => {
      if (query === '(prefers-reduced-motion: reduce)') return mql;
      return { ...mql, matches: false, media: query };
    }),
  );
}

describe('useCelebration', () => {
  beforeEach(() => {
    localStorage.clear();
    // mockReset (not mockClear) so tests that install a throwing implementation
    // don't leak into subsequent tests.
    confettiMock.mockReset();
    mockReducedMotion(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Single-render state machine cases ──

  it('does not celebrate on first load when no count is stored', () => {
    const { result } = renderHook(() => useCelebration(5));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('5');
  });

  it('does not celebrate when stored count matches the new count', () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result } = renderHook(() => useCelebration(5));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('5');
  });

  it('celebrates with singular message when delta is 1', async () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result } = renderHook(() => useCelebration(6));

    expect(result.current.celebration).not.toBeNull();
    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // canvas-confetti is dynamically imported on first fire (#1051); waitFor
    // lets the module's .then chain + fireConfetti run before we assert.
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('6');
  });

  it('celebrates with plural message when delta is greater than 1', async () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result } = renderHook(() => useCelebration(8));

    expect(result.current.celebration?.message).toBe('3 new PRs merged. Great work!');
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('8');
  });

  it('skips confetti but still shows toast under prefers-reduced-motion', () => {
    mockReducedMotion(true);
    localStorage.setItem(STORAGE_KEY, '5');
    const { result } = renderHook(() => useCelebration(6));

    expect(result.current.celebration).not.toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
  });

  it('silently resyncs when merged count decreases (e.g., PR deletion or history trim)', () => {
    localStorage.setItem(STORAGE_KEY, '10');
    const { result } = renderHook(() => useCelebration(7));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('7');
  });

  it('does nothing when mergedCount is undefined', () => {
    const { result } = renderHook(() => useCelebration(undefined));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  // ── Storage error handling ──

  it('handles localStorage.getItem throwing gracefully', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('storage restricted');
    });

    const { result } = renderHook(() => useCelebration(5));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
  });

  it('handles localStorage.setItem throwing gracefully during celebration', () => {
    localStorage.setItem(STORAGE_KEY, '5');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage full');
    });

    const { result } = renderHook(() => useCelebration(6));

    // Celebration still fires — the display path is independent of storage
    expect(result.current.celebration).not.toBeNull();
  });

  it('handles localStorage.setItem throwing during first-load seed without crashing', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('storage full');
    });

    // First load path: no stored value, hook tries to write. Must not throw.
    const { result } = renderHook(() => useCelebration(5));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
  });

  it('treats corrupted (non-numeric) stored value as first load', () => {
    localStorage.setItem(STORAGE_KEY, 'not-a-number');
    const { result } = renderHook(() => useCelebration(5));

    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    // Corrupt value gets silently overwritten with the valid seed
    expect(localStorage.getItem(STORAGE_KEY)).toBe('5');
  });

  // ── Edge values ──

  it('celebrates when stored count is 0 and new count is 1 (first-ever merge)', async () => {
    localStorage.setItem(STORAGE_KEY, '0');
    const { result } = renderHook(() => useCelebration(1));

    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  // ── Confetti failure handling ──

  it('still shows the toast when confetti throws and aborts the animation loop cleanly', async () => {
    confettiMock.mockImplementation(() => {
      throw new Error('no canvas');
    });
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
    localStorage.setItem(STORAGE_KEY, '5');

    const { result } = renderHook(() => useCelebration(6));

    // Toast must render even when the decorative animation fails
    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // Confetti throws on the first burst and the catch aborts the rAF loop,
    // so exactly one call is made.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(1));
    // The inner catch must abort the rAF loop — no follow-up frame scheduled
    expect(rafSpy).not.toHaveBeenCalled();
  });

  // ── Dismiss ──

  it('dismiss clears the celebration', () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result } = renderHook(() => useCelebration(6));

    expect(result.current.celebration).not.toBeNull();

    act(() => {
      result.current.dismiss();
    });

    expect(result.current.celebration).toBeNull();
  });

  // ── Rerender-based tests (multi-fetch page load sequences) ──

  it('seeds without celebrating when mergedCount transitions from undefined to a number', () => {
    const { result, rerender } = renderHook(({ count }: { count: number | undefined }) => useCelebration(count), {
      initialProps: { count: undefined as number | undefined },
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    rerender({ count: 5 });
    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(STORAGE_KEY)).toBe('5');
  });

  it('does not re-celebrate when silent refresh confirms the same count', async () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result, rerender } = renderHook(({ count }: { count: number }) => useCelebration(count), {
      initialProps: { count: 6 },
    });

    // Initial delta fires one celebration
    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    // Silent refresh returns the same count — hook effect should not re-run
    const callsAfterInitial = confettiMock.mock.calls.length;
    rerender({ count: 6 });

    // Same number of confetti calls (effect dep didn't change). Allow the
    // ongoing rAF loop to add a few more calls, but no NEW burst series.
    // The second celebration would double the count approximately; a single
    // continuation only grows it linearly.
    expect(confettiMock.mock.calls.length).toBeLessThan(callsAfterInitial * 2);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('6');
  });

  it('celebrates on delta detected by silent refresh after a stale initial fetch', async () => {
    // Scenario: cached data shows count=5 (unchanged), silent refresh picks up count=6
    localStorage.setItem(STORAGE_KEY, '5');
    const { result, rerender } = renderHook(({ count }: { count: number }) => useCelebration(count), {
      initialProps: { count: 5 },
    });

    // First render confirms stored count — no celebration
    expect(result.current.celebration).toBeNull();
    expect(confettiMock).not.toHaveBeenCalled();

    // Silent refresh surfaces a new merge
    rerender({ count: 6 });

    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('6');
  });

  it('celebrates independently on sequential deltas within the same session', async () => {
    localStorage.setItem(STORAGE_KEY, '5');
    const { result, rerender } = renderHook(({ count }: { count: number }) => useCelebration(count), {
      initialProps: { count: 6 },
    });

    expect(result.current.celebration?.message).toBe('1 new PR merged. Great work!');
    // fireConfetti fires 2 bursts per rAF tick; waitFor may catch additional
    // frames once the animation loop gets going. Asserting ≥ 2 covers the
    // initial burst without flaking on animation speed.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(2));

    // User dismisses, then a new merge arrives
    act(() => result.current.dismiss());
    rerender({ count: 8 });

    expect(result.current.celebration?.message).toBe('2 new PRs merged. Great work!');
    // 2 more bursts from the second fireConfetti call
    // Sequence of two celebrations → at least 4 bursts seen across both loops.
    await vi.waitFor(() => expect(confettiMock.mock.calls.length).toBeGreaterThanOrEqual(4));
    expect(localStorage.getItem(STORAGE_KEY)).toBe('8');
  });
});

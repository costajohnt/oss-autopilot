import { useState, useEffect, useCallback } from 'preact/hooks';
import confetti from 'canvas-confetti';

/**
 * Transient state describing an active celebration.
 *
 * `shownAt` is NOT an entity identifier — it's a `Date.now()` freshness token
 * used as a dependency in `CelebrationToast`'s auto-dismiss `useEffect`, so
 * that a new celebration arriving while one is already displayed resets the
 * 5-second timer. Keep this field monotonically increasing.
 */
export interface Celebration {
  message: string;
  shownAt: number;
}

const STORAGE_KEY = 'oss-autopilot-merged-count';

/**
 * Read-path storage error handler. Only swallows the `DOMException` family
 * (`SecurityError`, `QuotaExceededError`) that browsers throw in restricted
 * contexts (private mode, third-party storage disabled). Other errors
 * (`SyntaxError`, `TypeError`) indicate real bugs and should propagate.
 */
function readStoredCount(): number | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch (err) {
    if (err instanceof DOMException) {
      console.warn(`[useCelebration] localStorage unavailable (key=${STORAGE_KEY}):`, err);
      return null;
    }
    throw err;
  }
}

function writeStoredCount(count: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, String(count));
  } catch (err) {
    if (err instanceof DOMException) {
      console.warn(`[useCelebration] Failed to persist merged count (value=${count}):`, err);
      return;
    }
    throw err;
  }
}

/**
 * Fire a brief confetti show (~800ms) with stacked bursts from both sides.
 *
 * Canvas-confetti can throw in hardened browser contexts (canvas 2d context
 * creation denied, Shadow DOM mounts without `document.body`, etc). Because
 * this runs inside a `useEffect`, an unhandled throw would propagate into
 * Preact's commit phase and could blank the dashboard. Swallow confetti
 * failures — the toast is the canonical feedback, the animation is decorative.
 */
function fireConfetti(): void {
  const defaults = { startVelocity: 30, spread: 360, ticks: 60, zIndex: 9999 };
  const end = Date.now() + 800;

  function frame() {
    try {
      for (const xOffset of [0, 0.7]) {
        confetti({
          ...defaults,
          particleCount: 50,
          origin: { x: xOffset + Math.random() * 0.3, y: Math.random() - 0.2 },
        });
      }
    } catch (err) {
      console.warn('[useCelebration] confetti failed, aborting animation:', err);
      return;
    }

    if (Date.now() < end) {
      requestAnimationFrame(frame);
    }
  }

  frame();
}

/**
 * Fire confetti unless the user has requested reduced motion. `fireConfetti`
 * already swallows its own synchronous throws (see the try/catch in `frame()`
 * above), so callers don't need to wrap this in their own try/catch.
 */
function playConfettiIfAllowed(): void {
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (!reducedMotion) fireConfetti();
}

export function useCelebration(mergedCount: number | undefined): {
  celebration: Celebration | null;
  dismiss: () => void;
  trigger: () => void;
} {
  const [celebration, setCelebration] = useState<Celebration | null>(null);

  useEffect(() => {
    if (mergedCount === undefined) return;

    const stored = readStoredCount();

    // First load (no stored count) or count regression (PR deletion / history
    // trim upstream): resync silently without celebrating. On a full reload,
    // the stored count is now fresh, so the next real delta will be detected
    // correctly.
    if (stored === null || mergedCount <= stored) {
      if (stored !== mergedCount) writeStoredCount(mergedCount);
      return;
    }

    const delta = mergedCount - stored;
    writeStoredCount(mergedCount);
    playConfettiIfAllowed();

    const message = delta === 1 ? '1 new PR merged. Great work!' : `${delta} new PRs merged. Great work!`;
    setCelebration({ message, shownAt: Date.now() });
  }, [mergedCount]);

  const dismiss = useCallback(() => setCelebration(null), []);

  const trigger = useCallback(() => {
    playConfettiIfAllowed();
    setCelebration({ message: 'Party time!', shownAt: Date.now() });
  }, []);

  return { celebration, dismiss, trigger };
}

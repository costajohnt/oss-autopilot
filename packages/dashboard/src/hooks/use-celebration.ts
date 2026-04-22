import { useState, useEffect, useCallback } from 'preact/hooks';

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

// `canvas-confetti` is ~20 KB and only fires on merge-count increase or manual
// trigger (most page loads never call it). Dynamically import on first fire
// so the initial chunk stays lean (#1051). Module-scope cache + in-flight
// promise guarantee one fetch across all call sites.
type ConfettiFn = (opts: Record<string, unknown>) => void;
let confettiFn: ConfettiFn | null = null;
let confettiInflight: Promise<ConfettiFn | null> | null = null;

function loadConfetti(): Promise<ConfettiFn | null> {
  if (confettiFn) return Promise.resolve(confettiFn);
  if (confettiInflight) return confettiInflight;
  confettiInflight = import('canvas-confetti')
    .then((mod) => {
      confettiFn = mod.default as ConfettiFn;
      return confettiFn;
    })
    .catch((err) => {
      console.warn('[useCelebration] canvas-confetti import failed, skipping animation:', err);
      return null;
    });
  return confettiInflight;
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
function fireConfetti(confetti: ConfettiFn): void {
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
 * Fire confetti unless the user has requested reduced motion. Dynamically
 * imports `canvas-confetti` on first fire so page loads that never trigger
 * a celebration don't pay the download cost (#1051). Any import failure is
 * swallowed — the toast is canonical, the animation is decorative.
 */
function playConfettiIfAllowed(): void {
  const reducedMotion =
    typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  if (reducedMotion) return;
  loadConfetti().then((fn) => {
    if (fn) fireConfetti(fn);
  });
}

export function useCelebration(mergedCount: number | undefined): {
  celebration: Celebration | null;
  dismiss: () => void;
  /**
   * Fire a celebration toast on demand (#940). The optional `delta` controls
   * the message copy ("1 new PR merged." vs "3 new PRs merged."). Defaults to
   * 3 so the demo-mode button has a realistic-looking message. Does NOT touch
   * localStorage — the stored merged count is unaffected so the organic
   * on-increase celebration still fires later on a real merge.
   */
  trigger: (delta?: number) => void;
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

  const trigger = useCallback((delta = 3) => {
    playConfettiIfAllowed();
    const safeDelta = Number.isFinite(delta) && delta > 0 ? Math.floor(delta) : 3;
    const message = safeDelta === 1 ? '1 new PR merged. Great work!' : `${safeDelta} new PRs merged. Great work!`;
    setCelebration({ message, shownAt: Date.now() });
  }, []);

  return { celebration, dismiss, trigger };
}

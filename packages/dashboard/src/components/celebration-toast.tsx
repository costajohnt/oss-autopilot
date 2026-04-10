import { useEffect } from 'preact/hooks';
import type { Celebration } from '../hooks/use-celebration';

const AUTO_DISMISS_MS = 5000;

interface CelebrationToastProps {
  celebration: Celebration | null;
  onDismiss: () => void;
}

export function CelebrationToast({ celebration, onDismiss }: CelebrationToastProps) {
  // Depend on `shownAt` (not the celebration object) so the 5s auto-dismiss
  // timer only resets when a genuinely new celebration arrives, not on every
  // parent re-render that happens to produce a new object reference.
  useEffect(() => {
    if (!celebration) return;
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [celebration?.shownAt, onDismiss]);

  if (!celebration) return null;

  return (
    <div class="celebration-toast" role="status" aria-live="polite">
      <span class="celebration-toast-message">{celebration.message}</span>
      <button type="button" class="celebration-toast-dismiss" aria-label="Dismiss celebration" onClick={onDismiss}>
        &times;
      </button>
    </div>
  );
}

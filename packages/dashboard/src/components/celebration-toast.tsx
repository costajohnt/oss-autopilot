import { useMemo } from 'preact/hooks';

interface CelebrationToastProps {
  count: number;
  onDismiss: () => void;
}

const CONFETTI_COLORS = ['var(--green)', 'var(--purple)', 'var(--amber)', 'var(--blue)', 'var(--red)', 'var(--teal)'];
const CONFETTI_COUNT = 12;

export function CelebrationToast({ count, onDismiss }: CelebrationToastProps) {
  const confettiPieces = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }, (_, i) => ({
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        left: `${5 + (i * 90) / CONFETTI_COUNT + Math.random() * 5}%`,
        delay: `${i * 0.12}s`,
        duration: `${1.2 + Math.random() * 0.8}s`,
      })),
    [],
  );

  const message = count === 1 ? '1 new PR merged. Great work!' : `${count} new PRs merged. Great work!`;

  return (
    <div class="celebration-toast" role="status" aria-live="polite">
      <div class="celebration-confetti" aria-hidden="true">
        {confettiPieces.map((piece, i) => (
          <span
            key={i}
            class="confetti-piece"
            style={{
              backgroundColor: piece.color,
              left: piece.left,
              animationDelay: piece.delay,
              animationDuration: piece.duration,
            }}
          />
        ))}
      </div>
      <div class="celebration-content">
        <span class="celebration-emoji" aria-hidden="true">
          🎉
        </span>
        <span class="celebration-message">{message}</span>
        <button class="celebration-dismiss" onClick={onDismiss} aria-label="Dismiss notification">
          ×
        </button>
      </div>
    </div>
  );
}

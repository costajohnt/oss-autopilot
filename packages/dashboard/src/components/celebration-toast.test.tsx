import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { CelebrationToast } from './celebration-toast';

describe('CelebrationToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing when celebration is null', () => {
    const { container } = render(<CelebrationToast celebration={null} onDismiss={() => {}} />);
    expect(container.querySelector('.celebration-toast')).toBeNull();
  });

  it('renders the celebration message when present', () => {
    const celebration = { message: '3 new PRs merged. Great work!', shownAt: 1 };
    const { container } = render(<CelebrationToast celebration={celebration} onDismiss={() => {}} />);
    const toast = container.querySelector('.celebration-toast');
    expect(toast).toBeTruthy();
    expect(toast!.textContent).toContain('3 new PRs merged. Great work!');
  });

  it('has aria-live="polite" and role="status" for screen readers', () => {
    const celebration = { message: '1 new PR merged. Great work!', shownAt: 1 };
    const { container } = render(<CelebrationToast celebration={celebration} onDismiss={() => {}} />);
    const toast = container.querySelector('.celebration-toast');
    expect(toast!.getAttribute('role')).toBe('status');
    expect(toast!.getAttribute('aria-live')).toBe('polite');
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const celebration = { message: 'test', shownAt: 1 };
    const { container } = render(<CelebrationToast celebration={celebration} onDismiss={onDismiss} />);
    const button = container.querySelector('.celebration-toast-dismiss') as HTMLButtonElement;
    expect(button).toBeTruthy();
    expect(button.getAttribute('aria-label')).toBe('Dismiss celebration');
    fireEvent.click(button);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('auto-dismisses after 5 seconds', () => {
    const onDismiss = vi.fn();
    const celebration = { message: 'test', shownAt: 1 };
    render(<CelebrationToast celebration={celebration} onDismiss={onDismiss} />);

    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4999);
    expect(onDismiss).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('resets auto-dismiss timer when a new celebration shownAt arrives', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <CelebrationToast celebration={{ message: 'first', shownAt: 1 }} onDismiss={onDismiss} />,
    );

    vi.advanceTimersByTime(3000);
    // Swap in a new celebration before the first times out
    rerender(<CelebrationToast celebration={{ message: 'second', shownAt: 2 }} onDismiss={onDismiss} />);

    // Original 5s window would have fired at 5000ms — advance to 5001ms total
    vi.advanceTimersByTime(2001);
    expect(onDismiss).not.toHaveBeenCalled();

    // New 5s window starts at 3000ms, so it fires at 8000ms — advance to 8001ms total
    vi.advanceTimersByTime(2999);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('does NOT reset the timer when celebration object changes but shownAt is stable', () => {
    // This defends the `celebration?.shownAt` (not `celebration`) dep choice.
    // Without it, the timer would restart on every parent re-render producing
    // a new object reference — effectively never auto-dismissing.
    const onDismiss = vi.fn();
    const { rerender } = render(
      <CelebrationToast celebration={{ message: 'same', shownAt: 1 }} onDismiss={onDismiss} />,
    );

    vi.advanceTimersByTime(3000);
    // New object, same shownAt — simulates a parent re-render
    rerender(<CelebrationToast celebration={{ message: 'same', shownAt: 1 }} onDismiss={onDismiss} />);

    // Original 5s window still active — fires at 5000ms
    vi.advanceTimersByTime(2000);
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('clears the auto-dismiss timer when unmounted', () => {
    // Defends the `return () => clearTimeout(timer)` cleanup — without it,
    // the timer would fire onDismiss on an unmounted component.
    const onDismiss = vi.fn();
    const { unmount } = render(
      <CelebrationToast celebration={{ message: 'test', shownAt: 1 }} onDismiss={onDismiss} />,
    );

    unmount();
    vi.advanceTimersByTime(10_000);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { CelebrationToast } from './celebration-toast';

describe('CelebrationToast', () => {
  it('renders singular message for 1 merge', () => {
    const { getByText } = render(<CelebrationToast count={1} onDismiss={() => {}} />);
    expect(getByText('1 new PR merged. Great work!')).toBeTruthy();
  });

  it('renders plural message for multiple merges', () => {
    const { getByText } = render(<CelebrationToast count={3} onDismiss={() => {}} />);
    expect(getByText('3 new PRs merged. Great work!')).toBeTruthy();
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(<CelebrationToast count={2} onDismiss={onDismiss} />);
    fireEvent.click(getByLabelText('Dismiss notification'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('has role="status" for accessibility', () => {
    const { container } = render(<CelebrationToast count={1} onDismiss={() => {}} />);
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it('renders confetti pieces', () => {
    const { container } = render(<CelebrationToast count={1} onDismiss={() => {}} />);
    const pieces = container.querySelectorAll('.confetti-piece');
    expect(pieces.length).toBe(12);
  });

  it('confetti container has aria-hidden', () => {
    const { container } = render(<CelebrationToast count={1} onDismiss={() => {}} />);
    const confetti = container.querySelector('.celebration-confetti');
    expect(confetti?.getAttribute('aria-hidden')).toBe('true');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/preact';
import { AnimatedValue } from './animated-value';

describe('AnimatedValue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders a numeric value and animates to it', () => {
    const { container } = render(<AnimatedValue value={42} />);
    expect(container.textContent).toBe('0');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.textContent).toBe('42');
  });

  it('renders a string with numeric prefix and suffix', () => {
    const { container } = render(<AnimatedValue value="75%" />);
    expect(container.textContent).toBe('0%');

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(container.textContent).toBe('75%');
  });

  it('handles a value of 0', () => {
    const { container } = render(<AnimatedValue value={0} />);
    expect(container.textContent).toBe('0');
  });

  it('handles a non-numeric string by rendering it directly', () => {
    const { container } = render(<AnimatedValue value="N/A" />);
    expect(container.textContent).toBe('N/A');
  });

  it('animates integer values without decimals', () => {
    const { container } = render(<AnimatedValue value={10} />);

    act(() => {
      vi.advanceTimersByTime(200);
    });
    const midText = container.textContent!;
    expect(midText).toMatch(/^\d+$/);

    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(container.textContent).toBe('10');
  });

  it('does not crash when value transitions between number, numeric-string, and non-numeric-string', () => {
    // Regression: useCountUp must be called unconditionally, otherwise
    // Preact throws "Rendered fewer hooks than expected" on a shape change.
    const { container, rerender } = render(<AnimatedValue value={5} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe('5');

    rerender(<AnimatedValue value="42%" />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe('42%');

    rerender(<AnimatedValue value="N/A" />);
    expect(container.textContent).toBe('N/A');

    rerender(<AnimatedValue value={7} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(container.textContent).toBe('7');
  });
});

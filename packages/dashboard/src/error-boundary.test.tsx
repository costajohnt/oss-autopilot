/**
 * Tests for the dashboard error boundary (#1050).
 *
 * Uses @testing-library/preact for render + assertion. Exercises:
 * - Happy path: children render normally when no error occurs.
 * - Error path: a throwing child is caught, the default fallback is shown.
 * - Retry: clicking "Retry" resets the boundary and re-renders children.
 * - Custom fallback: the `fallback` prop replaces the default UI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, fireEvent, screen, cleanup } from '@testing-library/preact';
import { Component } from 'preact';
import { ErrorBoundary } from './error-boundary';

// Throw on first render; after the caller sets `shouldThrow=false` via the
// retry path, render cleanly. Lets us verify retry re-attempts the render.
class Thrower extends Component<{ shouldThrow: () => boolean; message: string }> {
  render() {
    if (this.props.shouldThrow()) {
      throw new Error(this.props.message);
    }
    return <div data-testid="child-ok">child rendered</div>;
  }
}

describe('ErrorBoundary', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Preact logs caught errors via console.error — silence during assertions.
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    cleanup();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div data-testid="happy">hello</div>
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('happy')).toBeTruthy();
  });

  it('catches a render-time throw and shows the default fallback with the error message', () => {
    render(
      <ErrorBoundary>
        <Thrower shouldThrow={() => true} message="boom: someField is undefined" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/dashboard crashed/i)).toBeTruthy();
    // Error details are in a <details> so expand / search the full text for
    // the embedded message.
    expect(screen.getByText(/boom: somefield is undefined/i)).toBeTruthy();
    // Reload / Retry buttons present.
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /reload/i })).toBeTruthy();
  });

  it('Retry resets the boundary and re-renders children', () => {
    let shouldThrow = true;
    const check = () => shouldThrow;

    render(
      <ErrorBoundary>
        <Thrower shouldThrow={check} message="first render crashed" />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/dashboard crashed/i)).toBeTruthy();

    shouldThrow = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    expect(screen.getByTestId('child-ok')).toBeTruthy();
  });

  it('renders a custom fallback when provided', () => {
    const CustomFallback = ({ error, retry }: { error: Error; retry: () => void }) => (
      <div>
        <span data-testid="custom-msg">custom: {error.message}</span>
        <button type="button" onClick={retry}>
          custom retry
        </button>
      </div>
    );

    render(
      <ErrorBoundary fallback={CustomFallback}>
        <Thrower shouldThrow={() => true} message="custom-path" />
      </ErrorBoundary>,
    );

    expect(screen.getByTestId('custom-msg').textContent).toContain('custom-path');
    expect(screen.queryByText(/dashboard crashed/i)).toBeNull();
  });
});

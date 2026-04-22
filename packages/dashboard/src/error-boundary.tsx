import { Component, type ComponentChildren, type ComponentType } from 'preact';

/**
 * Top-level error boundary (#1050).
 *
 * Any render-time throw below the boundary gets caught and rendered as a
 * fallback message with reload/retry affordances. Without this, a single bad
 * field reference (e.g. `data.foo.bar` when `foo` is suddenly undefined after
 * a server-side rename) unmounts the entire SPA tree with no user-visible
 * message — only a console error.
 *
 * Kept deliberately simple:
 * - One top-level boundary around `<App />` (sub-tree boundaries can be added
 *   later if specific panels start crashing in isolation).
 * - The reload button full-page-reloads, which also re-fetches `/api/data`.
 * - Troubleshooting note points the user at the CLI console and `/api/data`
 *   so they can inspect the response when the crash is caused by server drift.
 */

interface ErrorBoundaryProps {
  children: ComponentChildren;
  /**
   * Optional custom fallback. Receives the caught error and a retry callback
   * that clears the boundary's error state. Exists primarily to let tests
   * assert specific fallback UI without coupling to the default markup.
   */
  fallback?: ComponentType<{ error: Error; retry: () => void }>;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, errorInfo: unknown): void {
    // Log to the browser console so the developer / user can copy the stack
    // trace when reporting. Kept distinct from the in-UI fallback so the
    // fallback UI stays terse.
    console.error('[dashboard] uncaught render error:', error, errorInfo);
  }

  private retry = (): void => {
    this.setState({ error: null });
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      const Fallback = this.props.fallback;
      return <Fallback error={error} retry={this.retry} />;
    }

    return (
      <div
        role="alert"
        aria-live="assertive"
        style={{
          maxWidth: 640,
          margin: '2rem auto',
          padding: '1.5rem',
          border: '1px solid var(--error, #c0392b)',
          borderRadius: 6,
          background: 'var(--surface, #fff)',
          color: 'var(--text-primary, #111)',
          fontFamily: 'system-ui, -apple-system, sans-serif',
        }}
      >
        <h2 style={{ marginTop: 0 }}>Dashboard crashed</h2>
        <p>
          Something went wrong rendering the dashboard. This usually means the server returned an unexpected response
          shape or a UI component hit a null field.
        </p>
        <details style={{ margin: '1rem 0' }}>
          <summary style={{ cursor: 'pointer' }}>Technical details</summary>
          <pre style={{ whiteSpace: 'pre-wrap', fontSize: '0.85em', marginTop: '0.5rem' }}>{error.message}</pre>
        </details>
        <p style={{ fontSize: '0.9em' }}>
          Troubleshooting:
          <br />
          • Check the CLI console that started the dashboard server for errors.
          <br />• Open <code>/api/data</code> directly in a new tab to inspect the response shape.
          <br />• Rebuild the CLI with <code>pnpm run bundle</code> if you changed server code recently.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginTop: '1rem' }}>
          <button type="button" onClick={this.retry}>
            Retry
          </button>
          <button type="button" onClick={() => location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

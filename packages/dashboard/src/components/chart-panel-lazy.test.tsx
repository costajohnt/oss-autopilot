import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/preact';

// Stub the dynamic import target with a plain component so we don't pull
// Chart.js into jsdom. The LazyChartPanel resolves this module via
// `import('./chart-panel')`, mirroring production behavior minus the canvas
// work.
vi.mock('./chart-panel', () => ({
  ChartPanel: (props: { theme: string }) => <div data-testid="chart-panel">{props.theme}</div>,
}));

import { LazyChartPanel } from './chart-panel-lazy';

const defaultProps = {
  monthlyMerged: {},
  topRepos: [],
  theme: 'dark' as const,
};

afterEach(() => cleanup());

describe('LazyChartPanel', () => {
  it('survives unmount+remount after the lazy chunk has resolved', async () => {
    // First mount: module-scope cache is empty, so the effect kicks off the
    // dynamic import, then setComponent populates the cached reference.
    // Before the import resolves we should see the skeleton and no chart —
    // this pins the null-initializer path so a future refactor that breaks
    // `useState(() => cached)` when `cached` is null also trips this test.
    const first = render(<LazyChartPanel {...defaultProps} />);
    expect(first.queryByTestId('chart-panel')).toBeNull();
    expect(first.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    await waitFor(() => expect(first.queryByTestId('chart-panel')).not.toBeNull());
    first.unmount();

    // Second mount: `cached` is now the ChartPanel function. Passing a bare
    // function to useState triggers its lazy-initializer path and invokes the
    // component with undefined props. Wrapping `cached` in an initializer
    // closure (`() => cached`) sidesteps it.
    const second = render(<LazyChartPanel {...defaultProps} />);
    expect(second.queryByTestId('chart-panel')).not.toBeNull();
  });
});

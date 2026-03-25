import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/preact';
import { ChartPanel } from './chart-panel';

describe('ChartPanel', () => {
  it('renders canvas elements with aria-label and role="img"', () => {
    const { container } = render(<ChartPanel monthlyMerged={{}} topRepos={[]} theme="dark" />);
    const canvases = container.querySelectorAll('canvas');
    expect(canvases).toHaveLength(2);
    canvases.forEach((canvas) => {
      expect(canvas.getAttribute('role')).toBe('img');
      expect(canvas.getAttribute('aria-label')).toBeTruthy();
    });
  });
});

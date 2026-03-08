import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { ActionBar } from './action-bar';
import { makePR } from '../test-helpers';
import type { FetchedPR, ActionRequest } from '../types';

interface ActionBarOptions {
  pr?: FetchedPR;
  isShelved?: boolean;
  onAction?: (action: ActionRequest) => Promise<void>;
}

function renderActionBar(options: ActionBarOptions = {}) {
  const { pr = makePR(), isShelved = false, onAction = vi.fn() } = options;

  return render(<ActionBar pr={pr} isShelved={isShelved} onAction={onAction} />);
}

describe('ActionBar', () => {
  it('renders Shelve button when not shelved', () => {
    const { container } = renderActionBar();
    const btn = container.querySelector('.action-btn--shelve');
    expect(btn?.textContent).toBe('Shelve');
  });

  it('renders Unshelve button when shelved', () => {
    const { container } = renderActionBar({ isShelved: true });
    const btn = container.querySelector('.action-btn--unshelve');
    expect(btn?.textContent).toBe('Unshelve');
  });

  it('renders override button with "Move to Waiting" for needs_addressing PR', () => {
    const { container } = renderActionBar({ pr: makePR({ status: 'needs_addressing' }) });
    const btn = container.querySelector('.action-btn--override');
    expect(btn?.textContent).toBe('Move to Waiting');
  });

  it('renders override button with "Move to Need Attention" for waiting_on_maintainer PR', () => {
    const { container } = renderActionBar({ pr: makePR({ status: 'waiting_on_maintainer' }) });
    const btn = container.querySelector('.action-btn--override');
    expect(btn?.textContent).toBe('Move to Need Attention');
  });

  it('calls onAction with move shelved on shelve button click', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pr = makePR();

    const { container } = renderActionBar({ pr, onAction });

    const shelveBtn = container.querySelector('.action-btn--shelve') as HTMLButtonElement;
    fireEvent.click(shelveBtn);

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({ action: 'move', url: pr.url, target: 'shelved' });
    });
  });

  it('calls onAction with move waiting on override button click', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pr = makePR({ status: 'needs_addressing' });

    const { container } = renderActionBar({ pr, onAction });

    const overrideBtn = container.querySelector('.action-btn--override') as HTMLButtonElement;
    fireEvent.click(overrideBtn);

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({
        action: 'move',
        url: pr.url,
        target: 'waiting',
      });
    });
  });

  it('displays action error when onAction throws', async () => {
    const onAction = vi.fn().mockRejectedValue(new Error('Network error'));

    const { container } = renderActionBar({ onAction });

    const shelveBtn = container.querySelector('.action-btn--shelve') as HTMLButtonElement;
    fireEvent.click(shelveBtn);

    await waitFor(() => {
      expect(container.querySelector('.action-error')?.textContent).toBe('Network error');
    });
  });
});

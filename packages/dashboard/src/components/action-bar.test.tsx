import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/preact';
import { ActionBar } from './action-bar';
import { makePR } from '../test-helpers';
import type { FetchedPR, ActionRequest } from '../types';

interface ActionBarOptions {
  pr?: FetchedPR;
  isShelved?: boolean;
  isDismissed?: boolean;
  onAction?: (action: ActionRequest) => Promise<void>;
}

function renderActionBar(options: ActionBarOptions = {}) {
  const {
    pr = makePR(),
    isShelved = false,
    isDismissed = false,
    onAction = vi.fn(),
  } = options;

  return render(
    <ActionBar pr={pr} isShelved={isShelved} isDismissed={isDismissed} onAction={onAction} />,
  );
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

  it('renders Dismiss button when not dismissed', () => {
    const { container } = renderActionBar();
    const buttons = [...container.querySelectorAll('.action-btn')];
    const dismissBtn = buttons.find((b) => b.textContent === 'Dismiss');
    expect(dismissBtn).toBeTruthy();
  });

  it('renders Undismiss button when dismissed', () => {
    const { container } = renderActionBar({ isDismissed: true });
    const buttons = [...container.querySelectorAll('.action-btn')];
    const undismissBtn = buttons.find((b) => b.textContent === 'Undismiss');
    expect(undismissBtn).toBeTruthy();
  });

  it('shows snooze controls only when CI is failing', () => {
    const { container: passingContainer } = renderActionBar({ pr: makePR({ ciStatus: 'passing' }) });
    expect(passingContainer.querySelector('.action-btn--snooze')).toBeNull();

    const { container: failingContainer } = renderActionBar({ pr: makePR({ ciStatus: 'failing' }) });
    expect(failingContainer.querySelector('.action-btn--snooze')).toBeTruthy();
  });

  it('calls onAction with shelve action on button click', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pr = makePR();

    const { container } = renderActionBar({ pr, onAction });

    const shelveBtn = container.querySelector('.action-btn--shelve') as HTMLButtonElement;
    fireEvent.click(shelveBtn);

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({ action: 'shelve', url: pr.url });
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

  it('opens snooze form on "Snooze CI" click', () => {
    const { container } = renderActionBar({ pr: makePR({ ciStatus: 'failing' }) });

    expect(container.querySelector('.snooze-form')).toBeNull();

    const snoozeBtn = container.querySelector('.action-btn--snooze') as HTMLButtonElement;
    fireEvent.click(snoozeBtn);

    expect(container.querySelector('.snooze-form')).toBeTruthy();
  });

  it('submits snooze with reason and days', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const pr = makePR({ ciStatus: 'failing' });

    const { container } = renderActionBar({ pr, onAction });

    fireEvent.click(container.querySelector('.action-btn--snooze') as HTMLButtonElement);

    const reasonInput = container.querySelector('.snooze-input:not(.snooze-input--days)') as HTMLInputElement;
    fireEvent.input(reasonInput, { target: { value: 'Waiting on dependency update' } });

    const daysInput = container.querySelector('.snooze-input--days') as HTMLInputElement;
    fireEvent.input(daysInput, { target: { value: '7' } });

    fireEvent.click(container.querySelector('.action-btn--confirm') as HTMLButtonElement);

    await waitFor(() => {
      expect(onAction).toHaveBeenCalledWith({
        action: 'snooze',
        url: pr.url,
        reason: 'Waiting on dependency update',
        days: 7,
      });
    });
  });

  it('closes snooze form after successful submission', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);

    const { container } = renderActionBar({ pr: makePR({ ciStatus: 'failing' }), onAction });

    fireEvent.click(container.querySelector('.action-btn--snooze') as HTMLButtonElement);
    expect(container.querySelector('.snooze-form')).toBeTruthy();

    fireEvent.click(container.querySelector('.action-btn--confirm') as HTMLButtonElement);

    await waitFor(() => {
      expect(container.querySelector('.snooze-form')).toBeNull();
    });
  });
});

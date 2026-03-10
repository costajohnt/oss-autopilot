import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/preact';
import { PRDetail } from './pr-detail';
import { makePR } from '../test-helpers';
import type { FetchedPR, ActionRequest } from '../types';

interface PRDetailOptions {
  pr?: FetchedPR;
  isShelved?: boolean;
  onAction?: (action: ActionRequest) => Promise<void>;
  onClose?: () => void;
}

function renderPRDetail(options: PRDetailOptions = {}) {
  const { pr = makePR(), isShelved = false, onAction = vi.fn(), onClose = vi.fn() } = options;

  return {
    onClose,
    ...render(<PRDetail pr={pr} isShelved={isShelved} onAction={onAction} onClose={onClose} />),
  };
}

describe('PRDetail', () => {
  it('renders PR title and repo#number link', () => {
    const { container } = renderPRDetail({
      pr: makePR({ title: 'Fix edge case', repo: 'org/lib', number: 42 }),
    });

    expect(container.querySelector('.pr-detail-title')?.textContent).toBe('Fix edge case');
    expect(container.textContent).toContain('org/lib#42');
  });

  it('renders status label and description', () => {
    const { container } = renderPRDetail({
      pr: makePR({ displayLabel: '[CI Failing]', displayDescription: '3 checks failed' }),
    });

    expect(container.querySelector('.pill')?.textContent).toBe('CI Failing');
    expect(container.querySelector('.pr-detail-description')?.textContent).toBe('3 checks failed');
  });

  it('calls onClose when close button is clicked', () => {
    const onClose = vi.fn();
    const { container } = renderPRDetail({ onClose });

    const closeBtn = container.querySelector('.pr-detail-close') as HTMLButtonElement;
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it.each([
    ['approved', 'Approved'],
    ['changes_requested', 'Changes Requested'],
    ['review_required', 'Review Required'],
    ['unknown', 'Unknown'],
  ])('renders review label "%s" as "%s"', (decision, expected) => {
    const { container } = renderPRDetail({
      pr: makePR({ reviewDecision: decision as FetchedPR['reviewDecision'] }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const reviewField = [...fields].find((f) => f.querySelector('.pr-detail-field-label')?.textContent === 'Review');
    expect(reviewField?.querySelector('.pr-detail-field-value')?.textContent).toBe(expected);
  });

  it('renders CI status with capitalized text', () => {
    const { container } = renderPRDetail({
      pr: makePR({ ciStatus: 'failing' }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const ciField = [...fields].find((f) => f.querySelector('.pr-detail-field-label')?.textContent === 'CI Status');
    expect(ciField?.querySelector('.pr-detail-field-value')?.textContent).toBe('Failing');
  });

  it('renders classified checks with category badges when present', () => {
    const { container } = renderPRDetail({
      pr: makePR({
        classifiedChecks: [
          { name: 'tests', category: 'actionable' },
          { name: 'deploy', category: 'fork_limitation' },
        ],
      }),
    });

    const checks = container.querySelectorAll('.pr-detail-check');
    expect(checks).toHaveLength(2);
    expect(checks[0].querySelector('.pr-detail-check-name')?.textContent).toBe('tests');
    expect(checks[0].querySelector('.pr-detail-check-badge')?.textContent).toBe('Actionable');
    expect(checks[1].querySelector('.pr-detail-check-badge')?.textContent).toBe('Fork Limitation');
  });

  it('does not render checks section when classifiedChecks is empty', () => {
    const { container } = renderPRDetail({
      pr: makePR({ classifiedChecks: [] }),
    });

    expect(container.querySelector('.pr-detail-checks')).toBeNull();
  });

  it('renders maintainer comment when present', () => {
    const { container } = renderPRDetail({
      pr: makePR({
        lastMaintainerComment: {
          author: 'alice',
          body: 'Please add tests',
          createdAt: '2025-06-10T00:00:00Z',
        },
      }),
    });

    expect(container.querySelector('.pr-detail-comment-author')?.textContent).toBe('@alice');
    expect(container.querySelector('.pr-detail-comment-body')?.textContent).toBe('Please add tests');
  });

  it('does not render maintainer comment when absent', () => {
    const { container } = renderPRDetail({
      pr: makePR({ lastMaintainerComment: undefined }),
    });

    expect(container.querySelector('.pr-detail-comment')).toBeNull();
  });

  it('renders checklist stats when incomplete', () => {
    const { container } = renderPRDetail({
      pr: makePR({
        hasIncompleteChecklist: true,
        checklistStats: { checked: 2, total: 5 },
      }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const checklistField = [...fields].find(
      (f) => f.querySelector('.pr-detail-field-label')?.textContent === 'Checklist',
    );
    expect(checklistField?.querySelector('.pr-detail-field-value')?.textContent).toBe('2/5 checked');
  });

  it('does not render checklist when complete', () => {
    const { container } = renderPRDetail({
      pr: makePR({ hasIncompleteChecklist: false }),
    });

    const labels = [...container.querySelectorAll('.pr-detail-field-label')].map((el) => el.textContent);
    expect(labels).not.toContain('Checklist');
  });

  it('renders merge conflict indicator when present', () => {
    const { container } = renderPRDetail({
      pr: makePR({ hasMergeConflict: true }),
    });

    const labels = [...container.querySelectorAll('.pr-detail-field-label')].map((el) => el.textContent);
    expect(labels).toContain('Merge Conflict');
  });

  it('does not render merge conflict when absent', () => {
    const { container } = renderPRDetail({
      pr: makePR({ hasMergeConflict: false }),
    });

    const labels = [...container.querySelectorAll('.pr-detail-field-label')].map((el) => el.textContent);
    expect(labels).not.toContain('Merge Conflict');
  });

  it('renders days since activity', () => {
    const { container } = renderPRDetail({
      pr: makePR({ daysSinceActivity: 12 }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const activityField = [...fields].find(
      (f) => f.querySelector('.pr-detail-field-label')?.textContent === 'Days Since Activity',
    );
    expect(activityField?.querySelector('.pr-detail-field-value')?.textContent).toBe('12 days');
  });

  it('renders singular "day" for daysSinceActivity of 1', () => {
    const { container } = renderPRDetail({
      pr: makePR({ daysSinceActivity: 1 }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const activityField = [...fields].find(
      (f) => f.querySelector('.pr-detail-field-label')?.textContent === 'Days Since Activity',
    );
    expect(activityField?.querySelector('.pr-detail-field-value')?.textContent).toBe('1 day');
  });

  it.each([
    [0, 'green'],
    [2, 'green'],
    [3, 'amber'],
    [6, 'amber'],
    [7, 'red'],
    [30, 'red'],
  ])('renders activity dot with "%s" class for %i days', (days, expectedClass) => {
    const { container } = renderPRDetail({
      pr: makePR({ daysSinceActivity: days }),
    });

    const fields = container.querySelectorAll('.pr-detail-field');
    const activityField = [...fields].find(
      (f) => f.querySelector('.pr-detail-field-label')?.textContent === 'Days Since Activity',
    );
    const dot = activityField?.querySelector('.dot');
    expect(dot?.classList.contains(expectedClass)).toBe(true);
  });

  it('renders embedded ActionBar', () => {
    const { container } = renderPRDetail();
    expect(container.querySelector('.action-bar')).toBeTruthy();
  });
});

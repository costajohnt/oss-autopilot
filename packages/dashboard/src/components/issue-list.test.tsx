import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/preact';
import { IssueList } from './issue-list';
import { makeIssueResponse } from '../test-helpers';

describe('IssueList', () => {
  it('returns null when no issues', () => {
    const { container } = render(<IssueList issues={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('renders issue response items', () => {
    const issues = [
      makeIssueResponse({ title: 'Bug report', number: 42, repo: 'org/lib' }),
      makeIssueResponse({ title: 'Feature request', number: 43, repo: 'org/lib', isFromMaintainer: false }),
    ];

    const { container } = render(<IssueList issues={issues} />);

    expect(container.textContent).toContain('Issue Responses');
    expect(container.querySelectorAll('.issue-item')).toHaveLength(2);
    expect(container.textContent).toContain('org/lib#42');
    expect(container.textContent).toContain('Bug report');
  });

  it('shows maintainer badge for maintainer responses', () => {
    const issues = [makeIssueResponse({ isFromMaintainer: true })];

    const { container } = render(<IssueList issues={issues} />);

    const badge = container.querySelector('.issue-item-badge--maintainer');
    expect(badge?.textContent).toBe('Maintainer');
  });

  it('shows community badge for non-maintainer responses', () => {
    const issues = [makeIssueResponse({ isFromMaintainer: false })];

    const { container } = render(<IssueList issues={issues} />);

    const badge = container.querySelector('.issue-item-badge--community');
    expect(badge?.textContent).toBe('Community');
  });

  it('displays response author and body', () => {
    const issues = [
      makeIssueResponse({
        lastResponseAuthor: 'alice',
        lastResponseBody: 'Great contribution, thanks!',
      }),
    ];

    const { container } = render(<IssueList issues={issues} />);

    expect(container.textContent).toContain('@alice');
    expect(container.textContent).toContain('Great contribution, thanks!');
  });

  it('displays days since user comment', () => {
    const issues = [makeIssueResponse({ daysSinceUserComment: 7 })];

    const { container } = render(<IssueList issues={issues} />);

    expect(container.textContent).toContain('7d since your comment');
  });

  it('renders dismiss button for each issue', () => {
    const issues = [makeIssueResponse()];
    const { container } = render(<IssueList issues={issues} onAction={async () => {}} />);
    const btn = container.querySelector('.issue-item-dismiss');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Dismiss');
  });

  it('calls onAction with dismiss_issue_response when dismiss is clicked', async () => {
    const onAction = vi.fn().mockResolvedValue(undefined);
    const issue = makeIssueResponse({ url: 'https://github.com/org/repo/issues/42' });
    const { container } = render(<IssueList issues={[issue]} onAction={onAction} />);

    const btn = container.querySelector('.issue-item-dismiss') as HTMLButtonElement;
    btn.click();

    expect(onAction).toHaveBeenCalledWith({
      action: 'dismiss_issue_response',
      url: 'https://github.com/org/repo/issues/42',
    });
  });

  it('does not render dismiss button when onAction is not provided', () => {
    const issues = [makeIssueResponse()];
    const { container } = render(<IssueList issues={issues} />);
    const btn = container.querySelector('.issue-item-dismiss');
    expect(btn).toBeNull();
  });

  it('displays error message when dismiss action fails', async () => {
    const onAction = vi.fn().mockRejectedValue(new Error('Rate limited'));
    const issue = makeIssueResponse();
    const { container } = render(<IssueList issues={[issue]} onAction={onAction} />);

    const btn = container.querySelector('.issue-item-dismiss') as HTMLButtonElement;
    btn.click();

    await vi.waitFor(() => {
      expect(container.querySelector('.action-error')?.textContent).toBe('Rate limited');
    });
  });
});

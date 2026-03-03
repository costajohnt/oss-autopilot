import { describe, it, expect } from 'vitest';
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
});

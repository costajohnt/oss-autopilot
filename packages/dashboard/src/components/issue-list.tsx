import type { CommentedIssueWithResponse } from '../types';

interface IssueListProps {
  issues: CommentedIssueWithResponse[];
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return iso;
  }
}

export function IssueList({ issues }: IssueListProps) {
  if (issues.length === 0) {
    return (
      <div class="issue-list">
        <h3 class="issue-list-title">Issue Responses</h3>
        <p class="issue-list-empty">No issue responses</p>
      </div>
    );
  }

  return (
    <div class="issue-list">
      <h3 class="issue-list-title">Issue Responses</h3>
      <div class="issue-list-items">
        {issues.map((issue) => (
          <div key={issue.url} class="issue-item">
            <div class="issue-item-header">
              <a
                class="issue-item-id"
                href={issue.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                {issue.repo}#{issue.number}
              </a>
              <span
                class={`issue-item-badge ${
                  issue.isFromMaintainer
                    ? 'issue-item-badge--maintainer'
                    : 'issue-item-badge--community'
                }`}
              >
                {issue.isFromMaintainer ? 'Maintainer' : 'Community'}
              </span>
            </div>
            <div class="issue-item-title">{truncate(issue.title, 60)}</div>
            <div class="issue-item-response">
              <span class="issue-item-response-author">
                Response from @{issue.lastResponseAuthor}
              </span>
              <span class="issue-item-response-date">{formatDate(issue.lastResponseAt)}</span>
            </div>
            <p class="issue-item-response-body">{truncate(issue.lastResponseBody, 150)}</p>
            <span class="issue-item-age">{issue.daysSinceUserComment}d since your comment</span>
          </div>
        ))}
      </div>
    </div>
  );
}

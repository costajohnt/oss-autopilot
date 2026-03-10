import type { FetchedPR, ActionRequest } from '../types';
import { formatDate, statusColor, ciStatusColor, truncate, stripBrackets, pillColorClass } from '../utils';
import { ActionBar } from './action-bar';

interface PRDetailProps {
  pr: FetchedPR;
  isShelved: boolean;
  onAction: (action: ActionRequest) => Promise<void>;
  onClose: () => void;
}

function reviewLabel(decision: string): string {
  switch (decision) {
    case 'approved':
      return 'Approved';
    case 'changes_requested':
      return 'Changes Requested';
    case 'review_required':
      return 'Review Required';
    default:
      return 'Unknown';
  }
}

function reviewColor(decision: string): string {
  switch (decision) {
    case 'approved':
      return 'var(--green)';
    case 'changes_requested':
      return 'var(--red)';
    case 'review_required':
      return 'var(--amber)';
    default:
      return 'var(--text-muted)';
  }
}

/** Returns a CSS class for the colored dot indicator. */
function ciDotClass(status: string): string {
  switch (status) {
    case 'passing':
      return 'green';
    case 'failing':
      return 'red';
    case 'pending':
      return 'amber';
    default:
      return '';
  }
}

function reviewDotClass(decision: string): string {
  switch (decision) {
    case 'approved':
      return 'green';
    case 'changes_requested':
      return 'red';
    case 'review_required':
      return 'amber';
    default:
      return '';
  }
}

function categoryBadge(category: string): string {
  switch (category) {
    case 'actionable':
      return 'Actionable';
    case 'fork_limitation':
      return 'Fork Limitation';
    case 'auth_gate':
      return 'Auth Gate';
    case 'infrastructure':
      return 'Infrastructure';
    default:
      return category;
  }
}

export function PRDetail({ pr, isShelved, onAction, onClose }: PRDetailProps) {
  return (
    <div class="pr-detail">
      <div class="pr-detail-header">
        <h2 class="pr-detail-title">{pr.title}</h2>
        <button class="pr-detail-close" onClick={onClose} aria-label="Close">
          &times;
        </button>
      </div>

      <div class="pr-detail-meta">
        <span class={`pill ${pillColorClass(pr.displayLabel)}`}>{stripBrackets(pr.displayLabel)}</span>
        <span class="pr-detail-description">{pr.displayDescription}</span>
      </div>

      <div class="pr-detail-links">
        <a href={pr.url} target="_blank" rel="noopener noreferrer">
          {pr.repo}#{pr.number}
        </a>
      </div>

      <div class="pr-detail-fields">
        {/* CI Status */}
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">CI Status</span>
          <span class="pr-detail-field-value">
            {ciDotClass(pr.ciStatus) && <span class={`dot ${ciDotClass(pr.ciStatus)}`} />}
            <span style={{ color: ciStatusColor(pr.ciStatus) }}>
              {pr.ciStatus.charAt(0).toUpperCase() + pr.ciStatus.slice(1)}
            </span>
          </span>
        </div>

        {/* Failing checks */}
        {pr.classifiedChecks.length > 0 && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Failing Checks</span>
            <div class="pr-detail-checks">
              {pr.classifiedChecks.map((check) => (
                <div key={check.name} class="pr-detail-check">
                  <span class="pr-detail-check-name">{check.name}</span>
                  <span class={`pr-detail-check-badge pr-detail-check-badge--${check.category}`}>
                    {categoryBadge(check.category)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Review Decision */}
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Review</span>
          <span class="pr-detail-field-value">
            {reviewDotClass(pr.reviewDecision) && <span class={`dot ${reviewDotClass(pr.reviewDecision)}`} />}
            <span style={{ color: reviewColor(pr.reviewDecision) }}>{reviewLabel(pr.reviewDecision)}</span>
          </span>
        </div>

        {/* Maintainer Comment */}
        {pr.lastMaintainerComment && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Maintainer Comment</span>
            <div class="pr-detail-comment">
              <div class="pr-detail-comment-header">
                <div class="pr-detail-comment-avatar" />
                <span class="pr-detail-comment-author">@{pr.lastMaintainerComment.author}</span>
                <span class="pr-detail-comment-date">&middot; {formatDate(pr.lastMaintainerComment.createdAt)}</span>
              </div>
              <p class="pr-detail-comment-body">{truncate(pr.lastMaintainerComment.body, 200)}</p>
            </div>
          </div>
        )}

        {/* Checklist */}
        {pr.hasIncompleteChecklist && pr.checklistStats && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Checklist</span>
            <span class="pr-detail-field-value" style={{ color: 'var(--amber)' }}>
              {pr.checklistStats.checked}/{pr.checklistStats.total} checked
            </span>
          </div>
        )}

        {/* Days since activity */}
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Days Since Activity</span>
          <span class="pr-detail-field-value">
            <span class="dot red" />
            <span>
              {pr.daysSinceActivity} {pr.daysSinceActivity === 1 ? 'day' : 'days'}
            </span>
          </span>
        </div>

        {/* Merge conflict */}
        {pr.hasMergeConflict && (
          <div class="pr-detail-field">
            <span class="pr-detail-field-label">Merge Conflict</span>
            <span class="pr-detail-field-value" style={{ color: 'var(--red)' }}>
              Yes
            </span>
          </div>
        )}

        {/* Timestamps */}
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Created</span>
          <span class="pr-detail-field-value">{formatDate(pr.createdAt)}</span>
        </div>
        <div class="pr-detail-field">
          <span class="pr-detail-field-label">Updated</span>
          <span class="pr-detail-field-value">{formatDate(pr.updatedAt)}</span>
        </div>
      </div>

      <ActionBar pr={pr} isShelved={isShelved} onAction={onAction} />
    </div>
  );
}

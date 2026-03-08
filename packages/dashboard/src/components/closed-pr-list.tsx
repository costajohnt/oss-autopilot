import type { ClosedPR } from '../types';
import { truncate, formatDate } from '../utils';

interface ClosedPRListProps {
  closedPRs: ClosedPR[];
  onBack: () => void;
}

export function ClosedPRList({ closedPRs, onBack }: ClosedPRListProps) {
  return (
    <div class="merged-view">
      <div class="merged-view-header">
        <button class="merged-view-back" onClick={onBack} type="button">
          &larr; Back
        </button>
        <div>
          <h2 class="merged-view-title">Closed PRs</h2>
          <span class="merged-view-subtitle">{closedPRs.length} total</span>
        </div>
      </div>

      {closedPRs.length === 0 ? (
        <div class="merged-view-empty">No closed PRs found. Run a dashboard refresh to populate.</div>
      ) : (
        <div class="merged-view-list">
          {closedPRs.map((pr) => (
            <div key={pr.url} class="recent-activity-item">
              <span class="recent-activity-badge recent-activity-badge--closed">Closed</span>
              <a class="recent-activity-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {pr.repo}#{pr.number}
              </a>
              <span class="recent-activity-item-title">{truncate(pr.title, 60)}</span>
              <span class="recent-activity-date">{formatDate(pr.closedAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import type { MergedPR, ClosedPR, ShelvedPRRef } from '../types';
import { truncate, formatDate } from '../utils';

interface RecentActivityProps {
  mergedPRs: MergedPR[];
  closedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
}

export function RecentActivity({ mergedPRs, closedPRs, autoUnshelvedPRs }: RecentActivityProps) {
  if (mergedPRs.length === 0 && closedPRs.length === 0 && autoUnshelvedPRs.length === 0) {
    return null;
  }

  return (
    <div class="recent-activity">
      <h3 class="recent-activity-title">Recent Activity (Last 7 Days)</h3>

      {mergedPRs.length > 0 && (
        <div class="recent-activity-section">
          <h4 class="recent-activity-section-title recent-activity-section-title--merged">
            Merged ({mergedPRs.length})
          </h4>
          <div class="recent-activity-items">
            {mergedPRs.map((pr) => (
              <div key={pr.url} class="recent-activity-item">
                <span class="recent-activity-badge recent-activity-badge--merged">Merged</span>
                <span class="recent-activity-item-title">{truncate(pr.title, 60)}</span>
                <a class="recent-activity-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.repo}#{pr.number}
                </a>
                <span class="recent-activity-date">{formatDate(pr.mergedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {closedPRs.length > 0 && (
        <div class="recent-activity-section">
          <h4 class="recent-activity-section-title recent-activity-section-title--closed">
            Closed ({closedPRs.length})
          </h4>
          <div class="recent-activity-items">
            {closedPRs.map((pr) => (
              <div key={pr.url} class="recent-activity-item">
                <span class="recent-activity-badge recent-activity-badge--closed">Closed</span>
                <span class="recent-activity-item-title">{truncate(pr.title, 60)}</span>
                <a class="recent-activity-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.repo}#{pr.number}
                </a>
                <span class="recent-activity-date">{formatDate(pr.closedAt)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {autoUnshelvedPRs.length > 0 && (
        <div class="recent-activity-section">
          <h4 class="recent-activity-section-title recent-activity-section-title--unshelved">
            Auto-Unshelved ({autoUnshelvedPRs.length})
          </h4>
          <div class="recent-activity-items">
            {autoUnshelvedPRs.map((pr) => (
              <div key={pr.url} class="recent-activity-item">
                <span class="recent-activity-badge recent-activity-badge--unshelved">Unshelved</span>
                <span class="recent-activity-item-title">{truncate(pr.title, 60)}</span>
                <a class="recent-activity-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.repo}#{pr.number}
                </a>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

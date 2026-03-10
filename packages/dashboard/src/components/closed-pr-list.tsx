import type { ClosedPR } from '../types';
import { truncate, formatDate } from '../utils';

interface ClosedPRListProps {
  closedPRs: ClosedPR[];
  onBack: () => void;
}

export function ClosedPRList({ closedPRs, onBack }: ClosedPRListProps) {
  return (
    <div class="merged-view merged-view--full-width">
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
        <table class="merged-table">
          <thead>
            <tr>
              <th>PR</th>
              <th>Date Closed</th>
            </tr>
          </thead>
          <tbody>
            {closedPRs.map((pr) => (
              <tr key={pr.url}>
                <td>
                  <a class="merged-table-pr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                    {pr.repo}#{pr.number}
                  </a>
                  <div class="merged-table-pr-title">{truncate(pr.title, 80)}</div>
                </td>
                <td>
                  <span class="merged-table-date">{formatDate(pr.closedAt)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

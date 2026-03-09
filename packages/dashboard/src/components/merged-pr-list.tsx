import type { MergedPR, RepoMetadataEntry } from '../types';
import { truncate, formatDate, formatStarCount, getLanguageColor } from '../utils';

interface MergedPRListProps {
  mergedPRs: MergedPR[];
  repoMetadata?: Record<string, RepoMetadataEntry>;
  onBack: () => void;
}

export function MergedPRList({ mergedPRs, repoMetadata, onBack }: MergedPRListProps) {
  return (
    <div class="merged-view">
      <div class="merged-view-header">
        <button class="merged-view-back" onClick={onBack} type="button">
          &larr; Back
        </button>
        <div>
          <h2 class="merged-view-title">Merged PRs</h2>
          <span class="merged-view-subtitle">{mergedPRs.length} total</span>
        </div>
      </div>

      {mergedPRs.length === 0 ? (
        <div class="merged-view-empty">No merged PRs found. Run a dashboard refresh to populate.</div>
      ) : (
        <div class="merged-view-list">
          {mergedPRs.map((pr) => {
            const meta = repoMetadata?.[pr.repo];
            return (
              <div key={pr.url} class="recent-activity-item">
                <span class="recent-activity-badge recent-activity-badge--merged">Merged</span>
                <a class="recent-activity-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                  {pr.repo}#{pr.number}
                </a>
                {meta?.stars != null && <span class="merged-view-stars">★ {formatStarCount(meta.stars)}</span>}
                {meta?.language && (
                  <span class="merged-view-language">
                    <span
                      class="merged-view-language-dot"
                      style={{ backgroundColor: getLanguageColor(meta.language) }}
                    />
                    {meta.language}
                  </span>
                )}
                <span class="recent-activity-item-title">{truncate(pr.title, 60)}</span>
                <span class="recent-activity-date">{formatDate(pr.mergedAt)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

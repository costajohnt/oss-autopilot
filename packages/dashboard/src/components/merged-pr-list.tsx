import type { MergedPR, RepoMetadataEntry } from '../types';
import { truncate, formatDate, formatStarCount, getLanguageColor } from '../utils';

interface MergedPRListProps {
  mergedPRs: MergedPR[];
  repoMetadata?: Record<string, RepoMetadataEntry>;
  onBack: () => void;
}

export function MergedPRList({ mergedPRs, repoMetadata, onBack }: MergedPRListProps) {
  return (
    <div class="merged-view merged-view--full-width">
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
        <table class="merged-table">
          <thead>
            <tr>
              <th>PR</th>
              <th class="merged-table-col-stars">Stars</th>
              <th class="merged-table-col-language">Language</th>
              <th>Date Merged</th>
            </tr>
          </thead>
          <tbody>
            {mergedPRs.map((pr) => {
              const meta = repoMetadata?.[pr.repo];
              return (
                <tr key={pr.url}>
                  <td>
                    <a class="merged-table-pr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                      {pr.repo}#{pr.number}
                    </a>
                    <div class="merged-table-pr-title">{truncate(pr.title, 80)}</div>
                  </td>
                  <td class="merged-table-col-stars">
                    <span class="merged-table-stars">
                      {meta?.stars != null ? `★ ${formatStarCount(meta.stars)}` : '—'}
                    </span>
                  </td>
                  <td class="merged-table-col-language">
                    {meta?.language ? (
                      <span class="merged-table-language">
                        <span
                          class="merged-table-language-dot"
                          style={{ backgroundColor: getLanguageColor(meta.language) }}
                        />
                        {meta.language}
                      </span>
                    ) : (
                      <span class="merged-table-language">—</span>
                    )}
                  </td>
                  <td>
                    <span class="merged-table-date">{formatDate(pr.mergedAt)}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

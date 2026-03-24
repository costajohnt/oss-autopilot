import { useState, useMemo } from 'preact/hooks';
import type { MergedPR, RepoMetadataEntry } from '../types';
import { truncate, formatDate, formatStarCount, getLanguageColor } from '../utils';

interface MergedPRListProps {
  mergedPRs: MergedPR[];
  repoMetadata?: Record<string, RepoMetadataEntry>;
  onBack: () => void;
}

type SortKey = 'repo' | 'stars' | 'language' | 'date';
type SortDir = 'asc' | 'desc';

export function MergedPRList({ mergedPRs, repoMetadata, onBack }: MergedPRListProps) {
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'date' || key === 'stars' ? 'desc' : 'asc');
    }
  }

  const sorted = useMemo(() => {
    return [...mergedPRs].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'repo':
          cmp = a.repo.localeCompare(b.repo);
          break;
        case 'stars': {
          const sa = repoMetadata?.[a.repo]?.stars ?? 0;
          const sb = repoMetadata?.[b.repo]?.stars ?? 0;
          cmp = sa - sb;
          break;
        }
        case 'language': {
          const la = repoMetadata?.[a.repo]?.language ?? '';
          const lb = repoMetadata?.[b.repo]?.language ?? '';
          cmp = la.localeCompare(lb);
          break;
        }
        case 'date':
          cmp = a.mergedAt.localeCompare(b.mergedAt);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [mergedPRs, repoMetadata, sortKey, sortDir]);

  function renderHeader(key: SortKey, label: string, extraClass?: string) {
    const arrow = sortKey === key ? (sortDir === 'asc' ? '\u25B2' : '\u25BC') : null;
    const className = extraClass ? `${extraClass} sortable-th` : 'sortable-th';
    return (
      <th class={className} onClick={() => toggleSort(key)}>
        {label} {arrow && <span class="sort-arrow">{arrow}</span>}
      </th>
    );
  }

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
              {renderHeader('repo', 'PR')}
              {renderHeader('stars', 'Stars', 'merged-table-col-stars')}
              {renderHeader('language', 'Language', 'merged-table-col-language')}
              {renderHeader('date', 'Date Merged')}
            </tr>
          </thead>
          <tbody>
            {sorted.map((pr) => {
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

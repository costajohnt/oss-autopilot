import { useState, useMemo } from 'preact/hooks';
import type { ParseIssueListOutput, RepoMetadataEntry } from '../types';
import { truncate, formatStarCount, getLanguageColor } from '../utils';

interface VettedIssueListProps {
  vettedIssues: ParseIssueListOutput;
  repoMetadata?: Record<string, RepoMetadataEntry>;
  onBack: () => void;
}

/** Return the CSS modifier class for a vetting score. */
function scoreColorClass(score: number): string {
  if (score >= 8) return 'vetted-score--high';
  if (score >= 6) return 'vetted-score--mid';
  return '';
}

/** Extract stars and language from tier heading text as fallback when repoMetadata is missing */
function parseTierMeta(tier: string): { stars?: number; language?: string } {
  // Stars: (17.7k★) or (14k★) or (30k★) or (625★)
  let stars: number | undefined;
  const starsMatch = tier.match(/\(([\d.]+)([kK])?★\)/);
  if (starsMatch) {
    const num = parseFloat(starsMatch[1]);
    stars = starsMatch[2] ? Math.round(num * 1000) : num;
  }
  // Language: last parenthesized text in the heading, e.g., (TypeScript), (Rust), (JS)
  const langMatches = [...tier.matchAll(/\(([^)★\d][^)]*)\)/g)];
  const language = langMatches.length ? langMatches[langMatches.length - 1][1].trim() : undefined;
  return { stars, language };
}

export function VettedIssueList({ vettedIssues, repoMetadata, onBack }: VettedIssueListProps) {
  const [search, setSearch] = useState('');

  const items = useMemo(() => {
    // Filter out items with score < 6, then sort by score descending
    const filtered = vettedIssues.available.filter((item) => item.score === undefined || item.score >= 6);
    return filtered.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [vettedIssues.available]);

  const searched = useMemo(() => {
    if (!search) return items;
    const term = search.toLowerCase();
    return items.filter((item) => {
      const searchable = `${item.title} ${item.repo} ${item.number}`.toLowerCase();
      return searchable.includes(term);
    });
  }, [items, search]);

  return (
    <div class="merged-view merged-view--full-width">
      <div class="merged-view-header">
        <button class="merged-view-back" onClick={onBack} type="button">
          &larr; Back
        </button>
        <div>
          <h2 class="merged-view-title">Vetted Issues</h2>
          <span class="merged-view-subtitle">{items.length} available</span>
        </div>
      </div>

      <div class="vetted-search-bar">
        <input
          class="vetted-search-input"
          type="text"
          aria-label="Search issues"
          placeholder="Search issues..."
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        />
      </div>

      {searched.length === 0 ? (
        <div class="merged-view-empty">
          {items.length === 0 ? 'No vetted issues found.' : 'No issues match your search.'}
        </div>
      ) : (
        <table class="merged-table">
          <thead>
            <tr>
              <th scope="col">Issue</th>
              <th scope="col" class="merged-table-col-stars">
                Stars
              </th>
              <th scope="col" class="merged-table-col-language">
                Language
              </th>
              <th scope="col" class="vetted-col-score">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {searched.map((item) => {
              const meta = repoMetadata?.[item.repo];
              const tierMeta = !meta?.stars || !meta?.language ? parseTierMeta(item.tier) : null;
              const stars = meta?.stars ?? tierMeta?.stars;
              const language = meta?.language ?? tierMeta?.language;
              return (
                <tr key={item.url}>
                  <td>
                    <a class="merged-table-pr-link" href={item.url} target="_blank" rel="noopener noreferrer">
                      {item.repo}#{item.number}
                    </a>
                    <div class="merged-table-pr-title">{truncate(item.title, 80)}</div>
                  </td>
                  <td class="merged-table-col-stars">
                    <span class="merged-table-stars">
                      {stars != null ? `\u2605 ${formatStarCount(stars)}` : '\u2014'}
                    </span>
                  </td>
                  <td class="merged-table-col-language">
                    {language ? (
                      <span class="merged-table-language">
                        <span
                          class="merged-table-language-dot"
                          style={{ backgroundColor: getLanguageColor(language) }}
                        />
                        {language}
                      </span>
                    ) : (
                      <span class="merged-table-language">{'\u2014'}</span>
                    )}
                  </td>
                  <td class="vetted-col-score">
                    {item.score != null ? (
                      <span class={`vetted-score ${scoreColorClass(item.score)}`}>{item.score}/10</span>
                    ) : (
                      <span class="vetted-score">{'\u2014'}</span>
                    )}
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

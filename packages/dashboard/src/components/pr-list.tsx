import { useState } from 'preact/hooks';
import type { FetchedPR, FetchedPRStatus } from '../types';
import { truncate, statusColor, stripBrackets, pillColorClass } from '../utils';

interface PRListProps {
  prs: FetchedPR[];
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  shelvedUrls: Set<string>;
}

/** Statuses that belong in the "Need Attention" section. */
const NEED_ATTENTION: Set<FetchedPRStatus> = new Set(['needs_addressing']);

/** Statuses that belong in the "Waiting on Others" section. */
const WAITING: Set<FetchedPRStatus> = new Set(['waiting_on_maintainer']);

interface SectionDef {
  id: string;
  title: string;
  dotClass: string;
  prs: FetchedPR[];
}

/** Maps PR status to a CSS class for status-aware hover borders. */
export function statusClass(status: FetchedPRStatus): string {
  switch (status) {
    case 'needs_addressing':
      return 'pr-row--need-attention';
    case 'waiting_on_maintainer':
      return 'pr-row--waiting';
    default: {
      const _exhaustive: never = status;
      void _exhaustive;
      return '';
    }
  }
}

function PRRow({ pr, selected, onSelect }: { pr: FetchedPR; selected: boolean; onSelect: (url: string) => void }) {
  return (
    <div
      class={`pr-row ${statusClass(pr.status)} ${selected ? 'pr-row--selected' : ''}`}
      onClick={() => onSelect(pr.url)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(pr.url);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span class="pr-row-dot" style={{ background: statusColor(pr.status) }} />
      <a class="pr-row-id" href={pr.url} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>
        {pr.repo}#{pr.number}
      </a>
      <span class="pr-row-title">{truncate(pr.title, 50)}</span>
      {pr.displayLabel && (
        <span class={`pill ${pillColorClass(pr.displayLabel)}`}>{stripBrackets(pr.displayLabel)}</span>
      )}
      <span class="pr-row-age">{pr.daysSinceActivity}d ago</span>
    </div>
  );
}

function Section({
  section,
  selectedUrl,
  onSelect,
}: {
  section: SectionDef;
  selectedUrl: string | null;
  onSelect: (url: string) => void;
}) {
  return (
    <div class="pr-section">
      <div class="pr-section-header">
        <span class={`pr-section-dot ${section.dotClass}`} />
        <span class="pr-section-title">{section.title}</span>
        <span class="pr-section-count">{section.prs.length}</span>
      </div>
      {section.prs.map((pr) => (
        <PRRow key={pr.url} pr={pr} selected={pr.url === selectedUrl} onSelect={onSelect} />
      ))}
    </div>
  );
}

export function PRList({ prs, selectedUrl, onSelect, shelvedUrls }: PRListProps) {
  const [shelvedOpen, setShelvedOpen] = useState(false);

  const activePRs = prs.filter((pr) => !shelvedUrls.has(pr.url));
  const shelvedPRs = prs.filter((pr) => shelvedUrls.has(pr.url));

  const sections: SectionDef[] = [
    {
      id: 'action',
      title: 'Need Attention',
      dotClass: 'red',
      prs: activePRs.filter((pr) => NEED_ATTENTION.has(pr.status)),
    },
    {
      id: 'waiting',
      title: 'Waiting on Others',
      dotClass: 'blue',
      prs: activePRs.filter((pr) => WAITING.has(pr.status)),
    },
  ].filter((s) => s.prs.length > 0);

  return (
    <div class="pr-list">
      {sections.length === 0 && shelvedPRs.length === 0 && <p class="pr-list-empty">No PRs to display</p>}
      {sections.map((section) => (
        <Section key={section.id} section={section} selectedUrl={selectedUrl} onSelect={onSelect} />
      ))}
      {shelvedPRs.length > 0 && (
        <div class="pr-section pr-section--shelved">
          <div
            class="pr-section-header pr-section-header--collapsible"
            onClick={() => setShelvedOpen(!shelvedOpen)}
            aria-expanded={shelvedOpen}
            aria-controls="shelved-pr-list"
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setShelvedOpen(!shelvedOpen);
              }
            }}
          >
            <span class="pr-section-dot muted" />
            <span class="pr-section-title">Shelved</span>
            <span class="pr-section-count">{shelvedPRs.length}</span>
            <span class={`pr-section-chevron ${shelvedOpen ? 'pr-section-chevron--open' : ''}`}>&#9656;</span>
          </div>
          {shelvedOpen && (
            <div id="shelved-pr-list">
              {shelvedPRs.map((pr) => (
                <PRRow key={pr.url} pr={pr} selected={pr.url === selectedUrl} onSelect={onSelect} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

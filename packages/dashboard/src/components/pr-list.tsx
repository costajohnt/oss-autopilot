import { useState } from 'preact/hooks';
import type { FetchedPR, FetchedPRStatus } from '../types';
import { truncate, statusColor } from '../utils';

interface PRListProps {
  prs: FetchedPR[];
  selectedUrl: string | null;
  onSelect: (url: string) => void;
  shelvedUrls: Set<string>;
}

/** Statuses that belong in the "Action Required" section. */
const ACTION_REQUIRED: Set<FetchedPRStatus> = new Set([
  'needs_response',
  'needs_changes',
  'failing_ci',
  'merge_conflict',
  'incomplete_checklist',
  'missing_required_files',
  'needs_rebase',
]);

/** Statuses that belong in the "Waiting on Others" section. */
const WAITING: Set<FetchedPRStatus> = new Set([
  'changes_addressed',
  'waiting_on_maintainer',
  'ci_blocked',
  'ci_not_running',
]);

/** Statuses that belong in the "Healthy / Stale" section. */
const HEALTHY: Set<FetchedPRStatus> = new Set([
  'healthy',
  'approaching_dormant',
  'dormant',
  'waiting',
]);

interface SectionDef {
  id: string;
  title: string;
  accent: string;
  prs: FetchedPR[];
}

function PRRow({
  pr,
  selected,
  onSelect,
}: {
  pr: FetchedPR;
  selected: boolean;
  onSelect: (url: string) => void;
}) {
  return (
    <div
      class={`pr-row ${selected ? 'pr-row--selected' : ''}`}
      onClick={() => onSelect(pr.url)}
    >
      <span class="pr-row-dot" style={{ background: statusColor(pr.status) }} />
      <a
        class="pr-row-id"
        href={pr.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(e) => e.stopPropagation()}
      >
        {pr.repo}#{pr.number}
      </a>
      <span class="pr-row-title">{truncate(pr.title, 50)}</span>
      {pr.displayLabel && <span class="pr-row-label">{pr.displayLabel}</span>}
      <span class="pr-row-age">{pr.daysSinceActivity}d</span>
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
      <h3 class="pr-section-header" style={{ borderLeftColor: section.accent }}>
        {section.title}
        <span class="pr-section-count">{section.prs.length}</span>
      </h3>
      {section.prs.map((pr) => (
        <PRRow
          key={pr.url}
          pr={pr}
          selected={pr.url === selectedUrl}
          onSelect={onSelect}
        />
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
      title: 'Action Required',
      accent: 'var(--accent-error)',
      prs: activePRs.filter((pr) => ACTION_REQUIRED.has(pr.status)),
    },
    {
      id: 'waiting',
      title: 'Waiting on Others',
      accent: 'var(--accent-info)',
      prs: activePRs.filter((pr) => WAITING.has(pr.status)),
    },
    {
      id: 'healthy',
      title: 'Healthy / Stale',
      accent: 'var(--accent-open)',
      prs: activePRs.filter((pr) => HEALTHY.has(pr.status)),
    },
  ].filter((s) => s.prs.length > 0);

  return (
    <div class="pr-list">
      {sections.length === 0 && shelvedPRs.length === 0 && (
        <p class="pr-list-empty">No PRs to display</p>
      )}
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          selectedUrl={selectedUrl}
          onSelect={onSelect}
        />
      ))}
      {shelvedPRs.length > 0 && (
        <div class="pr-section pr-section--shelved">
          <h3
            class="pr-section-header pr-section-header--collapsible"
            style={{ borderLeftColor: 'var(--text-muted)' }}
            onClick={() => setShelvedOpen(!shelvedOpen)}
          >
            <span class={`pr-section-chevron ${shelvedOpen ? 'pr-section-chevron--open' : ''}`}>
              &#9656;
            </span>
            Shelved
            <span class="pr-section-count">{shelvedPRs.length}</span>
          </h3>
          {shelvedOpen &&
            shelvedPRs.map((pr) => (
              <PRRow
                key={pr.url}
                pr={pr}
                selected={pr.url === selectedUrl}
                onSelect={onSelect}
              />
            ))}
        </div>
      )}
    </div>
  );
}

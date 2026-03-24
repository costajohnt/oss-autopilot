import type { DashboardStats } from '../types';

interface StatsBarProps {
  stats: DashboardStats;
  onMergedClick?: () => void;
  onClosedClick?: () => void;
  onIssuesClick?: () => void;
}

interface StatCardDef {
  label: string;
  value: string | number;
  colorClass: string;
  onClick?: () => void;
}

export function StatsBar({ stats, onMergedClick, onClosedClick, onIssuesClick }: StatsBarProps) {
  const cards: StatCardDef[] = [
    { label: 'Active PRs', value: stats.activePRs, colorClass: 'green' },
    { label: 'Shelved PRs', value: stats.shelvedPRs, colorClass: 'blue' },
    { label: 'Merged PRs', value: stats.mergedPRs, colorClass: 'purple', onClick: onMergedClick },
    { label: 'Closed PRs', value: stats.closedPRs, colorClass: 'red', onClick: onClosedClick },
    { label: 'Merge Rate', value: stats.mergeRate, colorClass: 'amber' },
  ];
  if (stats.availableIssues !== undefined) {
    cards.push({ label: 'Vetted Issues', value: stats.availableIssues, colorClass: 'teal', onClick: onIssuesClick });
  }

  return (
    <div class="stats-bar">
      {cards.map((card) => {
        const Tag = card.onClick ? 'button' : 'div';
        return (
          <Tag
            key={card.label}
            class={`stat-card ${card.colorClass}${card.onClick ? ' stat-card--clickable' : ''}`}
            onClick={card.onClick}
            {...(card.onClick ? { type: 'button' as const } : {})}
          >
            <span class="stat-value">{card.value}</span>
            <span class="stat-label">{card.label}</span>
          </Tag>
        );
      })}
    </div>
  );
}

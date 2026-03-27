import type { DashboardStats } from '../types';

interface StatsBarProps {
  stats: DashboardStats;
  needAttentionCount: number;
  waitingCount: number;
  onNeedAttentionClick?: () => void;
  onWaitingClick?: () => void;
  onShelvedClick?: () => void;
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

export function StatsBar({
  stats,
  needAttentionCount,
  waitingCount,
  onNeedAttentionClick,
  onWaitingClick,
  onShelvedClick,
  onMergedClick,
  onClosedClick,
  onIssuesClick,
}: StatsBarProps) {
  const cards: StatCardDef[] = [
    { label: 'Need Attention', value: needAttentionCount, colorClass: 'red', onClick: onNeedAttentionClick },
    { label: 'Waiting on Others', value: waitingCount, colorClass: 'blue', onClick: onWaitingClick },
    { label: 'Shelved', value: stats.shelvedPRs, colorClass: 'muted', onClick: onShelvedClick },
    { label: 'Merged PRs', value: stats.mergedPRs, colorClass: 'purple', onClick: onMergedClick },
    { label: 'Closed PRs', value: stats.closedPRs, colorClass: 'red', onClick: onClosedClick },
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

import type { DashboardStats } from '../types';

interface StatsBarProps {
  stats: DashboardStats;
  onMergedClick?: () => void;
}

interface StatCardDef {
  label: string;
  value: string | number;
  accentVar: string;
  accentDimVar: string;
  onClick?: () => void;
}

export function StatsBar({ stats, onMergedClick }: StatsBarProps) {
  const cards: StatCardDef[] = [
    {
      label: 'Active PRs',
      value: stats.activePRs,
      accentVar: 'var(--accent-open)',
      accentDimVar: 'var(--accent-open-dim)',
    },
    {
      label: 'Shelved PRs',
      value: stats.shelvedPRs,
      accentVar: 'var(--accent-info)',
      accentDimVar: 'var(--accent-info-dim)',
    },
    {
      label: 'Merged PRs',
      value: stats.mergedPRs,
      accentVar: 'var(--accent-merged)',
      accentDimVar: 'var(--accent-merged-dim)',
      onClick: onMergedClick,
    },
    {
      label: 'Closed PRs',
      value: stats.closedPRs,
      accentVar: 'var(--accent-error)',
      accentDimVar: 'var(--accent-error-dim)',
    },
    {
      label: 'Merge Rate',
      value: stats.mergeRate,
      accentVar: 'var(--accent-warning)',
      accentDimVar: 'var(--accent-warning-dim)',
    },
  ];

  return (
    <div class="stats-bar">
      {cards.map((card) => {
        const Tag = card.onClick ? 'button' : 'div';
        return (
          <Tag
            key={card.label}
            class={`stat-card${card.onClick ? ' stat-card--clickable' : ''}`}
            style={{ borderLeftColor: card.accentVar, background: card.accentDimVar }}
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

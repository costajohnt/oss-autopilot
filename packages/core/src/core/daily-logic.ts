/**
 * Domain logic extracted from src/commands/daily.ts.
 *
 * Pure or near-pure functions that operate on FetchedPR data:
 *   - computeRepoSignals / groupPRsByRepo — per-repo aggregations
 *   - assessCapacity — capacity assessment against active PRs
 *   - collectActionableIssues — ordered list of issues needing attention
 *   - computeActionMenu — pre-computed action menu for orchestration
 *   - toShelvedPRRef — lightweight projection for digest display
 *   - formatActionHint — human-readable maintainer action hint label
 *   - formatBriefSummary / formatSummary / printDigest — rendering
 */

import { formatRelativeTime } from './utils.js';
import { warn } from './logger.js';
import { errorMessage } from './errors.js';
import { getStateManager } from './state.js';
import type {
  FetchedPR,
  FetchedPRStatus,
  StalenessTier,
  ActionReason,
  DailyDigest,
  AgentState,
  ShelvedPRRef,
  MaintainerActionHint,
  ComputedRepoSignals,
  RepoGroup,
  CommentedIssue,
  CommentedIssueWithResponse,
} from './types.js';
import type {
  CapacityAssessment,
  ActionableIssue,
  ActionableIssueType,
  ActionMenu,
  ActionMenuItem,
} from '../formatters/json.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Statuses indicating action needed from the contributor.
 * Used for auto-unshelving shelved PRs.
 */
export const CRITICAL_STATUSES: ReadonlySet<FetchedPRStatus> = new Set(['needs_addressing']);

/**
 * ActionReason values that indicate high-priority issues blocking capacity.
 * `incomplete_checklist` is excluded — it's actionable but not blocking.
 * Used in capacity assessment to determine if user can take on new work.
 */
export const CRITICAL_ACTION_REASONS: ReadonlySet<ActionReason> = new Set([
  'needs_response',
  'needs_changes',
  'failing_ci',
  'merge_conflict',
]);

/** Staleness tiers indicating staleness — maintainer comments during these tiers don't count as responsive. */
export const STALE_STATUSES: ReadonlySet<StalenessTier> = new Set(['dormant', 'approaching_dormant']);

// ---------------------------------------------------------------------------
// Status overrides
// ---------------------------------------------------------------------------

const VALID_OVERRIDE_STATUSES: ReadonlySet<FetchedPRStatus> = new Set(['needs_addressing', 'waiting_on_maintainer']);

/**
 * Apply status overrides from state to the PR list.
 * Overrides are auto-cleared if the PR has new activity since the override was set.
 *
 * When an override changes the status, the contradictory reason field is cleared
 * and an appropriate default is set so downstream logic (assessCapacity, collectActionableIssues)
 * works correctly.
 *
 * @param prs - The fetched PR list to apply overrides to
 * @param state - Current agent state containing status overrides
 * @returns New PR array with overrides applied (original array is not mutated)
 */
export function applyStatusOverrides(prs: FetchedPR[], state: Readonly<AgentState>): FetchedPR[] {
  const overrides = state.config.statusOverrides;
  if (!overrides || Object.keys(overrides).length === 0) return prs;

  const stateManager = getStateManager();

  // Wrap in batch: getStatusOverride may auto-clear stale overrides via clearStatusOverride,
  // which now auto-saves. Batching produces a single disk write for all auto-clears.
  let result: FetchedPR[] = [];
  stateManager.batch(() => {
    result = prs.map((pr) => {
      try {
        const override = stateManager.getStatusOverride(pr.url, pr.updatedAt);
        if (!override) {
          return pr;
        }
        if (!VALID_OVERRIDE_STATUSES.has(override.status)) {
          warn('daily-logic', `Invalid override status "${override.status}" for ${pr.url} — ignoring`);
          return pr;
        }
        if (override.status === pr.status) return pr;

        // Clear the contradictory reason field and set an appropriate default
        if (override.status === 'waiting_on_maintainer') {
          return { ...pr, status: override.status, actionReason: undefined, waitReason: 'pending_review' as const };
        }
        return { ...pr, status: override.status, waitReason: undefined, actionReason: 'needs_response' as const };
      } catch (err) {
        warn('daily-logic', `Failed to apply status override for ${pr.url}: ${errorMessage(err)}`);
        return pr;
      }
    });
  });

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build a map grouping PRs by repository, skipping PRs with empty repo fields.
 * Shared by groupPRsByRepo and computeRepoSignals.
 */
function buildRepoMap(prs: FetchedPR[], label: string): Map<string, FetchedPR[]> {
  const repoMap = new Map<string, FetchedPR[]>();
  for (const pr of prs) {
    if (!pr.repo) {
      warn(label, `Skipping PR #${pr.number} (${pr.url}) with empty repo field`);
      continue;
    }
    const existing = repoMap.get(pr.repo) || [];
    existing.push(pr);
    repoMap.set(pr.repo, existing);
  }
  return repoMap;
}

// ---------------------------------------------------------------------------
// Domain functions
// ---------------------------------------------------------------------------

/**
 * Project a PR to a lightweight ShelvedPRRef for digest output.
 * Only the fields needed for display are retained, reducing JSON payload size.
 *
 * @param pr - Any object with at least the ShelvedPRRef fields
 * @returns Lightweight reference for display
 */
export function toShelvedPRRef(pr: ShelvedPRRef): ShelvedPRRef {
  return {
    number: pr.number,
    url: pr.url,
    title: pr.title,
    repo: pr.repo,
    daysSinceActivity: pr.daysSinceActivity,
    status: pr.status,
  };
}

/**
 * Group PRs by repository (#80).
 * Ensures one agent per repo during parallel dispatch, preventing branch checkout conflicts.
 *
 * @param prs - PRs to group
 * @returns Array of repo groups, each with the repo name and its PRs
 */
export function groupPRsByRepo(prs: FetchedPR[]): RepoGroup[] {
  const repoMap = buildRepoMap(prs, 'GROUP_BY_REPO');
  const groups: RepoGroup[] = [];
  for (const [repo, repoPRs] of repoMap) {
    groups.push({ repo, prs: repoPRs });
  }
  return groups;
}

/**
 * Compute per-repo maintainer signals from observed open PR data.
 * - isResponsive: true if any PR in the repo has a maintainer comment and stalenessTier is active
 * - hasActiveMaintainers: true if any non-stale PR exists in the repo (stalenessTier is 'active')
 *
 * @param prs - Open PRs to compute signals from
 * @returns Map of repo names to maintainer responsiveness signals
 */
export function computeRepoSignals(prs: FetchedPR[]): Map<string, ComputedRepoSignals> {
  const repoMap = buildRepoMap(prs, 'COMPUTE_SIGNALS');
  const result = new Map<string, ComputedRepoSignals>();
  for (const [repo, repoPRs] of repoMap) {
    const isResponsive = repoPRs.some((pr) => pr.lastMaintainerComment && !STALE_STATUSES.has(pr.stalenessTier));
    const hasActiveMaintainers = repoPRs.some((pr) => !STALE_STATUSES.has(pr.stalenessTier));
    result.set(repo, { isResponsive, hasActiveMaintainers });
  }
  return result;
}

/**
 * Assess whether user has capacity for new issues.
 * Only active (non-shelved) PRs count against the limit.
 *
 * @param activePRs - Non-shelved open PRs
 * @param maxActivePRs - User's configured PR limit
 * @param shelvedPRCount - Number of shelved PRs (for display)
 * @returns Capacity assessment with reason string
 */
export function assessCapacity(
  activePRs: FetchedPR[],
  maxActivePRs: number,
  shelvedPRCount: number,
): CapacityAssessment {
  const activePRCount = activePRs.length;
  const criticalIssueCount = activePRs.filter(
    (pr) => pr.status === 'needs_addressing' && pr.actionReason && CRITICAL_ACTION_REASONS.has(pr.actionReason),
  ).length;

  // Has capacity if: under PR limit AND no critical issues
  const underPRLimit = activePRCount < maxActivePRs;
  const noCriticalIssues = criticalIssueCount === 0;
  const hasCapacity = underPRLimit && noCriticalIssues;

  // Generate reason
  let reason: string;
  const shelvedNote = shelvedPRCount > 0 ? ` + ${shelvedPRCount} shelved` : '';
  if (hasCapacity) {
    reason = `You have capacity: ${activePRCount}/${maxActivePRs} active PRs${shelvedNote}, no critical issues`;
  } else {
    const reasons: string[] = [];
    if (!underPRLimit) {
      reasons.push(`at PR limit (${activePRCount}/${maxActivePRs}${shelvedNote})`);
    }
    if (!noCriticalIssues) {
      reasons.push(`${criticalIssueCount} critical issue${criticalIssueCount === 1 ? '' : 's'} need attention`);
    }
    reason = `No capacity: ${reasons.join(', ')}`;
  }

  return {
    hasCapacity,
    activePRCount,
    maxActivePRs,
    shelvedPRCount,
    criticalIssueCount,
    reason,
  };
}

/**
 * Collect all actionable issues across PRs for the action-first flow.
 * Order: Needs response -> Needs changes -> CI failing -> Merge conflicts -> Incomplete checklist
 *
 * Note: Recently closed PRs are informational only and excluded from this list.
 * They are available separately in digest.recentlyClosedPRs (#156).
 *
 * @param prs - Active (non-shelved) PRs to check
 * @param lastDigestAt - ISO timestamp of previous digest (for "new contribution" detection)
 * @returns Ordered actionable issues grouped by priority
 */
export function collectActionableIssues(prs: FetchedPR[], lastDigestAt?: string): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const actionPRs = prs.filter((pr) => pr.status === 'needs_addressing');
  const lastDigestTime = lastDigestAt ? new Date(lastDigestAt).getTime() : NaN;

  const reasonOrder: ActionReason[] = [
    'needs_response',
    'needs_changes',
    'failing_ci',
    'merge_conflict',
    'incomplete_checklist',
  ];

  for (const reason of reasonOrder) {
    for (const pr of actionPRs) {
      if (pr.actionReason !== reason) continue;

      let label: string;
      let type: ActionableIssueType;
      switch (reason) {
        case 'needs_response':
          label = '[Needs Response]';
          type = 'needs_response';
          break;
        case 'needs_changes':
          label = '[Needs Changes]';
          type = 'needs_changes';
          break;
        case 'failing_ci': {
          const checkInfo = pr.failingCheckNames.length > 0 ? ` (${pr.failingCheckNames.join(', ')})` : '';
          label = `[CI Failing${checkInfo}]`;
          type = 'ci_failing';
          break;
        }
        case 'merge_conflict':
          label = '[Merge Conflict]';
          type = 'merge_conflict';
          break;
        case 'incomplete_checklist': {
          const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : '';
          label = `[Incomplete Checklist${stats}]`;
          type = 'incomplete_checklist';
          break;
        }
        default:
          // Defensive fallback for ActionReason values not explicitly handled
          // above (e.g. ci_not_running, needs_rebase, missing_required_files).
          // These aren't in reasonOrder today but this guards future additions.
          warn('daily-logic', `Unhandled ActionReason "${reason}" for PR ${pr.url} — falling back to needs_response`);
          label = `[${reason}]`;
          type = 'needs_response';
      }

      // A PR is "new" if it was created after the last daily digest (first time seen).
      // If there's no previous digest (first run) or createdAt is invalid, assume new.
      const createdTime = new Date(pr.createdAt).getTime();
      let isNewContribution: boolean;
      if (isNaN(createdTime)) {
        warn('daily-logic', `Invalid createdAt "${pr.createdAt}" for PR ${pr.url}, assuming new contribution`);
        isNewContribution = true;
      } else {
        isNewContribution = isNaN(lastDigestTime) || createdTime > lastDigestTime;
      }

      issues.push({ type, pr, label, isNewContribution });
    }
  }

  return issues;
}

/**
 * Format a maintainer action hint as a human-readable label.
 * @param hint - The maintainer action hint enum value
 * @returns Human-readable label (e.g., "tests requested")
 */
export function formatActionHint(hint: MaintainerActionHint): string {
  switch (hint) {
    case 'demo_requested':
      return 'demo/screenshot requested';
    case 'tests_requested':
      return 'tests requested';
    case 'changes_requested':
      return 'code changes requested';
    case 'docs_requested':
      return 'documentation requested';
    case 'rebase_requested':
      return 'rebase requested';
  }
}

/**
 * Compute the action menu from PR data and capacity.
 * The orchestration layer can insert issue-list options (e.g., "Pick from list")
 * using the context flags.
 *
 * @param actionableIssues - Issues requiring attention
 * @param capacity - Current capacity assessment
 * @param commentedIssues - Issues with comment activity
 * @returns Action menu with context flags for orchestration
 */
export function computeActionMenu(
  actionableIssues: ActionableIssue[],
  capacity: CapacityAssessment,
  commentedIssues: CommentedIssue[] = [],
): ActionMenu {
  const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');
  const items: ActionMenuItem[] = [];
  const hasActionableIssues = actionableIssues.length > 0;
  const hasIssueResponses = issueResponses.length > 0;

  if (hasActionableIssues) {
    const isSingle = actionableIssues.length === 1;
    items.push({
      key: 'address_all',
      label: isSingle
        ? 'Address this issue (Recommended)'
        : `Work through all ${actionableIssues.length} issues (Recommended)`,
      description: isSingle
        ? 'Fix the issue blocking your PR'
        : 'Run maintenance in parallel, then address code changes one at a time',
    });
  }

  // Issue replies — positioned after address_all but before search
  if (hasIssueResponses) {
    items.push({
      key: 'issue_replies',
      label: `Review ${issueResponses.length} issue repl${issueResponses.length === 1 ? 'y' : 'ies'}`,
      description: 'Maintainers responded to your comments on issues',
    });
  }

  // The orchestration layer (commands/oss.md Action Menu section) may insert issue-list
  // options before the search item when a curated list is available.

  items.push({
    key: 'search',
    label: 'Search for new issues',
    description: 'Look for new contribution opportunities',
  });

  items.push({
    key: 'done',
    label: 'Done for now',
    description: 'End session with summary',
  });

  return {
    items,
    context: {
      hasActionableIssues,
      actionableCount: actionableIssues.length,
      hasCapacity: capacity.hasCapacity,
      hasIssueResponses,
      issueResponseCount: issueResponses.length,
    },
  };
}

// ---------------------------------------------------------------------------
// Rendering / formatting
// ---------------------------------------------------------------------------

/**
 * Format a brief one-liner summary for the action-first flow.
 *
 * @param digest - The daily digest containing PR summary stats
 * @param issueCount - Number of actionable issues needing attention
 * @param issueResponseCount - Number of issue replies from maintainers
 * @returns One-line status string (e.g., "3 Active PRs | 1 needs attention | 2 issue replies")
 */
export function formatBriefSummary(digest: DailyDigest, issueCount: number, issueResponseCount: number = 0): string {
  const attentionText = issueCount > 0 ? `${issueCount} need${issueCount === 1 ? 's' : ''} attention` : 'all on track';
  const issueReplyText =
    issueResponseCount > 0 ? ` | ${issueResponseCount} issue repl${issueResponseCount === 1 ? 'y' : 'ies'}` : '';
  return `\u{1F4CA} ${digest.summary.totalActivePRs} Active PRs | ${attentionText}${issueReplyText}`;
}

/**
 * Format the full dashboard summary as markdown.
 * Used in JSON output for Claude to display verbatim — includes all PR sections,
 * issue replies, and capacity status.
 *
 * @param digest - The daily digest with all PR categories
 * @param capacity - Current capacity assessment for display
 * @param issueResponses - Issue replies from maintainers to display
 * @returns Multi-line markdown string suitable for terminal or chat display
 */
export function formatSummary(
  digest: DailyDigest,
  capacity: CapacityAssessment,
  issueResponses: CommentedIssueWithResponse[] = [],
): string {
  const lines: string[] = [];

  // Header
  lines.push('## OSS Dashboard');
  lines.push('');
  lines.push(
    `\u{1F4CA} **${digest.summary.totalActivePRs} Active PRs** | ${digest.summary.totalMergedAllTime} Merged | ${digest.summary.mergeRate}% Merge Rate`,
  );
  lines.push('\u2713 Dashboard generated \u2014 say "open dashboard" to view in browser');
  lines.push('');

  // Needs Addressing
  if (digest.needsAddressingPRs.length > 0) {
    lines.push('### \u274C Needs Addressing');
    for (const pr of digest.needsAddressingPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  \u2514\u2500 ${pr.displayLabel} ${pr.displayDescription}`);
    }
    lines.push('');
  }

  // Waiting on Maintainer
  if (digest.waitingOnMaintainerPRs.length > 0) {
    lines.push('### \u23F3 Waiting on Maintainer');
    for (const pr of digest.waitingOnMaintainerPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  \u2514\u2500 ${pr.displayDescription}`);
    }
    lines.push('');
  }

  // Recently Merged (wins!)
  if (digest.recentlyMergedPRs.length > 0) {
    lines.push('### \u{1F389} Recently Merged');
    for (const pr of digest.recentlyMergedPRs) {
      const mergedDate = pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${mergedDate ? ` (merged ${mergedDate})` : ''}`);
    }
    lines.push('');
  }

  // Recently Closed (closed without merge)
  if (digest.recentlyClosedPRs.length > 0) {
    lines.push('### \u{1F6AB} Recently Closed');
    for (const pr of digest.recentlyClosedPRs) {
      const closedDate = pr.closedAt ? new Date(pr.closedAt).toLocaleDateString() : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${closedDate ? ` (closed ${closedDate})` : ''}`);
    }
    lines.push('');
  }

  // Auto-unshelved (important: maintainer engagement on shelved PRs)
  if (digest.autoUnshelvedPRs.length > 0) {
    lines.push('### \u{1F514} Auto-Unshelved');
    lines.push('> These PRs were shelved but a maintainer engaged \u2014 moved back to active.');
    for (const pr of digest.autoUnshelvedPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.status.replace(/_/g, ' ')})`);
    }
    lines.push('');
  }

  // Shelved PRs (dimmed, excluded from capacity)
  if (digest.shelvedPRs.length > 0) {
    lines.push('### \u{1F4E6} Shelved');
    for (const pr of digest.shelvedPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  // Issue Replies
  if (issueResponses.length > 0) {
    lines.push('### \u{1F4AC} Issue Replies');
    for (const issue of issueResponses) {
      lines.push(`- [${issue.repo}#${issue.number}](${issue.url}): ${issue.title}`);
      const timeAgo = formatRelativeTime(issue.lastResponseAt);
      lines.push(
        `  \u2514\u2500 @${issue.lastResponseAuthor}: "${issue.lastResponseBody.slice(0, 80)}${issue.lastResponseBody.length > 80 ? '...' : ''}"${timeAgo ? ` (${timeAgo})` : ''}`,
      );
    }
    lines.push('');
  }

  // Capacity
  const capacityIcon = capacity.hasCapacity ? '\u2705' : '\u26A0\uFE0F';
  const capacityLabel = capacity.hasCapacity ? 'Ready for new work' : 'Focus on existing PRs';
  const shelvedNote = capacity.shelvedPRCount > 0 ? ` + ${capacity.shelvedPRCount} shelved` : '';
  lines.push(
    `**Capacity:** ${capacityIcon} ${capacityLabel} (${capacity.activePRCount}/${capacity.maxActivePRs} PRs${shelvedNote})`,
  );

  return lines.join('\n');
}

/**
 * Print digest to console as plain text.
 * Unified renderer: uses the same section ordering as {@link formatSummary}
 * but outputs plain text with console.log instead of markdown links.
 *
 * @param digest - The daily digest with all PR categories
 * @param capacity - Current capacity assessment for display
 * @param commentedIssues - All commented issues (filtered to responses internally)
 */
export function printDigest(
  digest: DailyDigest,
  capacity: CapacityAssessment,
  commentedIssues: CommentedIssue[] = [],
): void {
  console.log('\n\u{1F4CA} OSS Daily Check\n');
  console.log(`Active PRs: ${digest.summary.totalActivePRs}`);
  console.log(`Needing Attention: ${digest.summary.totalNeedingAttention}`);
  console.log(`Merged (all time): ${digest.summary.totalMergedAllTime}`);
  console.log(`Merge Rate: ${digest.summary.mergeRate}%`);
  console.log(
    `\nCapacity: ${capacity.hasCapacity ? '\u2705 Ready for new work' : '\u26A0\uFE0F  Focus on existing work'}`,
  );
  console.log(`  ${capacity.reason}\n`);

  if (digest.needsAddressingPRs.length > 0) {
    console.log('\u274C Needs Addressing:');
    for (const pr of digest.needsAddressingPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    ${pr.displayLabel} ${pr.displayDescription}`);
    }
    console.log('');
  }

  if (digest.waitingOnMaintainerPRs.length > 0) {
    console.log('\u23F3 Waiting on Maintainer:');
    for (const pr of digest.waitingOnMaintainerPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    ${pr.displayDescription}`);
    }
    console.log('');
  }

  if (digest.recentlyMergedPRs.length > 0) {
    console.log('\u{1F389} Recently Merged:');
    for (const pr of digest.recentlyMergedPRs) {
      const mergedDate = pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}${mergedDate ? ` (merged ${mergedDate})` : ''}`);
    }
    console.log('');
  }

  if (digest.recentlyClosedPRs.length > 0) {
    console.log('\u{1F6AB} Recently Closed:');
    for (const pr of digest.recentlyClosedPRs) {
      const closedDate = pr.closedAt ? new Date(pr.closedAt).toLocaleDateString() : '';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}${closedDate ? ` (closed ${closedDate})` : ''}`);
    }
    console.log('');
  }

  if (digest.autoUnshelvedPRs.length > 0) {
    console.log('\u{1F514} Auto-Unshelved:');
    for (const pr of digest.autoUnshelvedPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title} (${pr.status.replace(/_/g, ' ')})`);
    }
    console.log('');
  }

  if (digest.shelvedPRs.length > 0) {
    console.log('\u{1F4E6} Shelved:');
    for (const pr of digest.shelvedPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  const issueResponses = commentedIssues.filter((i): i is CommentedIssueWithResponse => i.status === 'new_response');
  if (issueResponses.length > 0) {
    console.log('\u{1F4AC} Issue Replies:');
    for (const issue of issueResponses) {
      console.log(`  - ${issue.repo}#${issue.number}: ${issue.title}`);
      console.log(
        `    @${issue.lastResponseAuthor}: ${issue.lastResponseBody.slice(0, 80)}${issue.lastResponseBody.length > 80 ? '...' : ''}`,
      );
    }
    console.log('');
  }

  console.log('Run with --json for structured output');
  console.log('Run "dashboard serve" for browser view');
}

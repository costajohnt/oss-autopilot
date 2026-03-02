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
import type {
  FetchedPR,
  FetchedPRStatus,
  DailyDigest,
  ShelvedPRRef,
  MaintainerActionHint,
  ComputedRepoSignals,
  RepoGroup,
  CommentedIssue,
  CommentedIssueWithResponse,
} from './types.js';
import type { CapacityAssessment, ActionableIssue, ActionMenu, ActionMenuItem } from '../formatters/json.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Statuses indicating maintainer engagement or action needed from the contributor.
 * Used both for auto-unshelving shelved PRs and for counting critical issues in capacity assessment.
 */
export const CRITICAL_STATUSES: ReadonlySet<FetchedPRStatus> = new Set([
  'needs_response',
  'needs_changes',
  'failing_ci',
  'merge_conflict',
]);

/** Statuses indicating active maintainer engagement (reviews, feedback, merges). */
export const ACTIVE_MAINTAINER_STATUSES: ReadonlySet<FetchedPRStatus> = new Set([
  'healthy',
  'waiting_on_maintainer',
  'changes_addressed',
  'needs_response',
  'needs_changes',
]);

/** Statuses indicating staleness — maintainer comments during these statuses don't count as responsive. */
export const STALE_STATUSES: ReadonlySet<FetchedPRStatus> = new Set(['dormant', 'approaching_dormant']);

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
 * Map a full FetchedPR to a lightweight ShelvedPRRef for digest output.
 * Only the fields needed for display are retained, reducing JSON payload size.
 */
export function toShelvedPRRef(pr: FetchedPR): ShelvedPRRef {
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
 * - isResponsive: true if any PR in the repo has a maintainer comment and status
 *   is not in STALE_STATUSES
 * - hasActiveMaintainers: true if any PR in the repo has a status in ACTIVE_MAINTAINER_STATUSES
 */
export function computeRepoSignals(prs: FetchedPR[]): Map<string, ComputedRepoSignals> {
  const repoMap = buildRepoMap(prs, 'COMPUTE_SIGNALS');
  const result = new Map<string, ComputedRepoSignals>();
  for (const [repo, repoPRs] of repoMap) {
    const isResponsive = repoPRs.some((pr) => pr.lastMaintainerComment && !STALE_STATUSES.has(pr.status));
    const hasActiveMaintainers = repoPRs.some((pr) => ACTIVE_MAINTAINER_STATUSES.has(pr.status));
    result.set(repo, { isResponsive, hasActiveMaintainers });
  }
  return result;
}

/**
 * Assess whether user has capacity for new issues.
 * Only active (non-shelved) PRs count against the limit.
 */
export function assessCapacity(
  activePRs: FetchedPR[],
  maxActivePRs: number,
  shelvedPRCount: number,
): CapacityAssessment {
  const activePRCount = activePRs.length;
  const criticalIssueCount = activePRs.filter((pr) => CRITICAL_STATUSES.has(pr.status)).length;

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
 */
export function collectActionableIssues(prs: FetchedPR[], snoozedUrls: Set<string> = new Set()): ActionableIssue[] {
  const issues: ActionableIssue[] = [];

  // 1. Needs Response (highest priority - someone is waiting for you)
  for (const pr of prs) {
    if (pr.status === 'needs_response') {
      issues.push({ type: 'needs_response', pr, label: '[Needs Response]' });
    }
  }

  // 2. Needs Changes (review requested changes, contributor hasn't pushed new code)
  for (const pr of prs) {
    if (pr.status === 'needs_changes') {
      issues.push({ type: 'needs_changes', pr, label: '[Needs Changes]' });
    }
  }

  // 3. CI Failing (include check names so user can distinguish real CI from validation bots)
  // Skip snoozed PRs — their CI failures are known and temporarily dismissed
  for (const pr of prs) {
    if (pr.status === 'failing_ci' && !snoozedUrls.has(pr.url)) {
      const checkInfo = pr.failingCheckNames.length > 0 ? ` (${pr.failingCheckNames.join(', ')})` : '';
      issues.push({ type: 'ci_failing', pr, label: `[CI Failing${checkInfo}]` });
    }
  }

  // 4. Merge Conflicts
  for (const pr of prs) {
    if (pr.status === 'merge_conflict') {
      issues.push({ type: 'merge_conflict', pr, label: '[Merge Conflict]' });
    }
  }

  // 5. Incomplete Checklist
  for (const pr of prs) {
    if (pr.status === 'incomplete_checklist') {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : '';
      issues.push({ type: 'incomplete_checklist', pr, label: `[Incomplete Checklist${stats}]` });
    }
  }

  return issues;
}

/**
 * Format a maintainer action hint as a human-readable label
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
    items.push({
      key: 'address_all',
      label: `Work through all ${actionableIssues.length} issue${actionableIssues.length === 1 ? '' : 's'} (Recommended)`,
      description: 'Run maintenance in parallel, then address code changes one at a time',
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
 * Format a brief one-liner summary for the action-first flow
 */
export function formatBriefSummary(digest: DailyDigest, issueCount: number, issueResponseCount: number = 0): string {
  const attentionText = issueCount > 0 ? `${issueCount} need${issueCount === 1 ? 's' : ''} attention` : 'all healthy';
  const issueReplyText =
    issueResponseCount > 0 ? ` | ${issueResponseCount} issue repl${issueResponseCount === 1 ? 'y' : 'ies'}` : '';
  return `\u{1F4CA} ${digest.summary.totalActivePRs} Active PRs | ${attentionText}${issueReplyText}`;
}

/**
 * Format summary as markdown (used in JSON output for Claude to display verbatim)
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

  // CI Failing
  if (digest.ciFailingPRs.length > 0) {
    lines.push('### \u274C CI Failing');
    for (const pr of digest.ciFailingPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      if (pr.failingCheckNames.length > 0) {
        lines.push(`  \u2514\u2500 Failing: ${pr.failingCheckNames.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Merge Conflicts
  if (digest.mergeConflictPRs.length > 0) {
    lines.push('### \u26A0\uFE0F Merge Conflicts');
    for (const pr of digest.mergeConflictPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  // Needs Response
  if (digest.prsNeedingResponse.length > 0) {
    lines.push('### \u{1F4AC} Needs Response');
    for (const pr of digest.prsNeedingResponse) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  \u2514\u2500 @${maintainer} commented`);
      if (pr.maintainerActionHints.length > 0) {
        const hintLabels = pr.maintainerActionHints.map(formatActionHint).join(', ');
        lines.push(`  \u2514\u2500 Action: ${hintLabels}`);
      }
    }
    lines.push('');
  }

  // Needs Changes (review requested changes, no new commits yet)
  if (digest.needsChangesPRs.length > 0) {
    lines.push('### \u{1F527} Needs Changes');
    for (const pr of digest.needsChangesPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  \u2514\u2500 Review requested changes \u2014 push commits to address`);
    }
    lines.push('');
  }

  // Incomplete Checklist
  if (digest.incompleteChecklistPRs.length > 0) {
    lines.push('### \u{1F4CB} Incomplete Checklist');
    for (const pr of digest.incompleteChecklistPRs) {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total} checked)` : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${stats}`);
    }
    lines.push('');
  }

  // Changes Addressed (waiting for maintainer re-review)
  if (digest.changesAddressedPRs.length > 0) {
    lines.push('### \u{1F4E4} Changes Addressed');
    for (const pr of digest.changesAddressedPRs) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  \u2514\u2500 Waiting for @${maintainer} to re-review`);
    }
    lines.push('');
  }

  // Waiting on Maintainer (approved, no action needed from user)
  if (digest.waitingOnMaintainerPRs.length > 0) {
    lines.push('### \u23F3 Waiting on Maintainer');
    for (const pr of digest.waitingOnMaintainerPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (approved)`);
    }
    lines.push('');
  }

  // Healthy PRs
  if (digest.healthyPRs.length > 0) {
    lines.push('### \u2705 Healthy');
    for (const pr of digest.healthyPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
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
 * Print digest to console (simple text output).
 * Unified renderer: uses the same section ordering as formatSummary
 * but outputs plain text with console.log instead of markdown links.
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

  if (digest.ciFailingPRs.length > 0) {
    console.log('\u274C CI Failing:');
    for (const pr of digest.ciFailingPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      if (pr.failingCheckNames.length > 0) {
        console.log(`    Failing: ${pr.failingCheckNames.join(', ')}`);
      }
    }
    console.log('');
  }

  if (digest.mergeConflictPRs.length > 0) {
    console.log('\u26A0\uFE0F Merge Conflicts:');
    for (const pr of digest.mergeConflictPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  if (digest.prsNeedingResponse.length > 0) {
    console.log('\u{1F4AC} Needs Response:');
    for (const pr of digest.prsNeedingResponse) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      if (pr.maintainerActionHints.length > 0) {
        const hintLabels = pr.maintainerActionHints.map(formatActionHint).join(', ');
        console.log(`    Action: ${hintLabels}`);
      }
    }
    console.log('');
  }

  if (digest.needsChangesPRs.length > 0) {
    console.log('\u{1F527} Needs Changes:');
    for (const pr of digest.needsChangesPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    Review requested changes \u2014 push commits to address`);
    }
    console.log('');
  }

  if (digest.incompleteChecklistPRs.length > 0) {
    console.log('\u{1F4CB} Incomplete Checklist:');
    for (const pr of digest.incompleteChecklistPRs) {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total} checked)` : '';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}${stats}`);
    }
    console.log('');
  }

  if (digest.changesAddressedPRs.length > 0) {
    console.log('\u{1F4E4} Changes Addressed:');
    for (const pr of digest.changesAddressedPRs) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    Waiting for @${maintainer} to re-review`);
    }
    console.log('');
  }

  if (digest.waitingOnMaintainerPRs.length > 0) {
    console.log('\u23F3 Waiting on Maintainer:');
    for (const pr of digest.waitingOnMaintainerPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title} (approved)`);
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
  console.log('Run "dashboard --open" for browser view');
}

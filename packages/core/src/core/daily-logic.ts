/**
 * Domain aggregation logic extracted from src/commands/daily.ts.
 *
 * Pure or near-pure functions that operate on FetchedPR data and produce
 * the data types that the renderers / JSON output consume:
 *   - computeRepoSignals / groupPRsByRepo — per-repo aggregations
 *   - assessCapacity — capacity assessment against active PRs
 *   - collectActionableIssues — ordered list of issues needing attention
 *   - computeActionMenu — pre-computed action menu for orchestration
 *   - toShelvedPRRef — lightweight projection for digest display
 *
 * Rendering functions (formatActionHint, formatBriefSummary, formatSummary,
 * printDigest) live in src/commands/daily-render.ts (#1117). This file
 * re-exports them at the bottom so existing imports keep working without
 * a sweep.
 */

import { warn } from './logger.js';
import { errorMessage } from './errors.js';
import { getStateManager } from './state.js';
import type { AttentionSummary } from './pr-attention.js';
import type {
  FetchedPR,
  FetchedPRStatus,
  StalenessTier,
  ActionReason,
  AgentState,
  ShelvedPRRef,
  ComputedRepoSignals,
  RepoGroup,
  CommentedIssue,
  CommentedIssueWithResponse,
  CapacityAssessment,
  ActionableIssue,
  ActionableIssueType,
  ActionMenu,
  ActionMenuItem,
  StarFilter,
} from './types.js';

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
 * @param failures - Optional collector (#1448): a message is pushed for each
 *   PR whose override lookup threw (that PR keeps its un-overridden status).
 *   Call sites surface these in warnings[]/partialFailures so the silently
 *   wrong status is visible in the envelope, not just stderr.
 * @returns New PR array with overrides applied (original array is not mutated)
 */
export function applyStatusOverrides(prs: FetchedPR[], state: Readonly<AgentState>, failures?: string[]): FetchedPR[] {
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
        const message = `Failed to apply status override for ${pr.url}: ${errorMessage(err)}`;
        warn('daily-logic', message);
        failures?.push(message);
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
 * Build a star filter from state for use in fetchUserPRCounts.
 *
 * Returns undefined if no star data is available (first run). Pure logic
 * over `Readonly<AgentState>` — lives here in core/daily-logic.ts so the
 * dashboard layer can reuse it without importing from a sibling command
 * module (#1208 M7).
 *
 * @param state - Current agent state (read-only)
 * @returns Star filter with minimum threshold and known counts, or undefined on first run
 */
export function buildStarFilter(state: Readonly<AgentState>): StarFilter | undefined {
  const minStars = state.config.minStars ?? 50;
  const knownStarCounts = new Map<string, number>();
  for (const [repo, score] of Object.entries(state.repoScores)) {
    if (score.stargazersCount !== undefined) {
      knownStarCounts.set(repo, score.stargazersCount);
    }
  }
  if (knownStarCounts.size === 0) return undefined;
  return { minStars, knownStarCounts };
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

  // #1352: every needs_addressing PR produces exactly one entry, including
  // PRs whose actionReason is missing or outside reasonOrder (the defensive
  // default below). This keeps the CLI brief's count equal to the dashboard's
  // needs_attention bucket by construction — previously an unmapped reason
  // silently dropped the PR from the brief while the dashboard still counted
  // it. Unmapped reasons sort last.
  const sortedPRs = [...actionPRs].sort((a, b) => {
    const rank = (pr: FetchedPR) => {
      const i = reasonOrder.indexOf(pr.actionReason as ActionReason);
      return i === -1 ? reasonOrder.length : i;
    };
    return rank(a) - rank(b);
  });

  for (const pr of sortedPRs) {
    if (pr.actionReason === undefined) {
      warn('daily-logic', `needs_addressing PR ${pr.url} has no actionReason — defaulting to needs_response`);
    }
    const reason: ActionReason = pr.actionReason ?? 'needs_response';

    let label: string;
    let type: ActionableIssueType;
    switch (reason) {
      case 'needs_response': {
        label = '[Needs Response]';
        type = 'needs_response';
        break;
      }
      case 'needs_changes': {
        label = '[Needs Changes]';
        type = 'needs_changes';
        break;
      }
      case 'failing_ci': {
        const checkInfo = pr.failingCheckNames.length > 0 ? ` (${pr.failingCheckNames.join(', ')})` : '';
        label = `[CI Failing${checkInfo}]`;
        type = 'ci_failing';
        break;
      }
      case 'merge_conflict': {
        label = '[Merge Conflict]';
        type = 'merge_conflict';
        break;
      }
      case 'incomplete_checklist': {
        const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : '';
        label = `[Incomplete Checklist${stats}]`;
        type = 'incomplete_checklist';
        break;
      }
      default: {
        // Defensive fallback for ActionReason values not explicitly handled
        // above (e.g. ci_not_running, needs_rebase, missing_required_files).
        // These aren't in reasonOrder today but this guards future additions.
        warn('daily-logic', `Unhandled ActionReason "${reason}" for PR ${pr.url} — falling back to needs_response`);
        label = `[${reason}]`;
        type = 'needs_response';
      }
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

  return issues;
}

/**
 * Compute the action menu from PR data and capacity.
 * The orchestration layer can insert issue-list options (e.g., "Pick from list")
 * using the context flags.
 *
 * @param actionableIssues - Issues requiring attention
 * @param capacity - Current capacity assessment
 * @param commentedIssues - Issues with comment activity
 * @param attention - Attention bucket counts; non-zero stuck-CI / dormant-followup buckets add a follow_up item
 * @returns Action menu with context flags for orchestration
 */
export function computeActionMenu(
  actionableIssues: ActionableIssue[],
  capacity: CapacityAssessment,
  commentedIssues: CommentedIssue[] = [],
  attention?: Pick<AttentionSummary, 'stuckCI' | 'dormantFollowup'>,
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

  // Follow-up nudges (#1462) — the stuck_ci / dormant_followup buckets from
  // summarizeAttentionBuckets get a menu path to workflows/dormant-pr-follow-up.md
  // instead of only a headline count. Emitted only when a bucket is non-zero,
  // so menus without stuck/dormant PRs are unchanged.
  const stuckCI = attention?.stuckCI ?? 0;
  const dormantFollowup = attention?.dormantFollowup ?? 0;
  if (stuckCI > 0 || dormantFollowup > 0) {
    const parts: string[] = [];
    if (stuckCI > 0) parts.push(`${stuckCI} stuck-CI`);
    if (dormantFollowup > 0) parts.push(`${dormantFollowup} dormant`);
    const total = stuckCI + dormantFollowup;
    items.push({
      key: 'follow_up',
      label: `Follow up on ${parts.join(' and ')} PR${total === 1 ? '' : 's'}`,
      description: 'Waiting PRs that may need a nudge (pending CI or no review activity)',
    });
  }

  // The orchestration layer (commands/oss.md Action Menu section) may insert issue-list
  // options before the search item when a curated list is available.

  const searchItem: ActionMenuItem = {
    key: 'search',
    label: 'Search for new issues',
    description: 'Look for new contribution opportunities',
  };
  if (!capacity.hasCapacity) {
    const atLimit = capacity.activePRCount >= capacity.maxActivePRs;
    const hasCritical = capacity.criticalIssueCount > 0;
    if (atLimit && hasCritical) {
      searchItem.capacityWarning = `You're at ${capacity.activePRCount}/${capacity.maxActivePRs} active PRs and have ${capacity.criticalIssueCount} critical issue(s). Resolve existing work before claiming new issues.`;
    } else if (atLimit) {
      searchItem.capacityWarning = `You're at ${capacity.activePRCount}/${capacity.maxActivePRs} active PRs. Claiming a new issue will exceed your limit.`;
    } else {
      searchItem.capacityWarning = `You have ${capacity.criticalIssueCount} critical issue(s) needing attention. Resolve them before claiming new issues.`;
    }
  }
  items.push(searchItem);

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
// Rendering re-exports (back-compat)
// ---------------------------------------------------------------------------
//
// The actual implementations live in src/commands/daily-render.ts. Existing
// callers that import these from `core/daily-logic` continue to work; new
// callers should import from `commands/daily-render` directly.
export { formatActionHint, formatBriefSummary, formatSummary, printDigest } from '../commands/daily-render.js';

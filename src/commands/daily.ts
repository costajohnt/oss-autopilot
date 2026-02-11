/**
 * Daily check command
 * Fetches all open PRs fresh from GitHub (v2: no PR-level state tracking),
 * generates a digest, and updates repo scores and analytics in local state.
 */

import { getStateManager, PRMonitor, IssueConversationMonitor, getGitHubToken, formatRelativeTime, type DailyDigest, type FetchedPR, type FetchedPRStatus, type PRCheckFailure, type MaintainerActionHint, type ClosedPR, type ComputedRepoSignals, type RepoGroup, type CommentedIssue } from '../core/index.js';
import { outputJson, outputJsonError, type DailyOutput, type CapacityAssessment, type ActionableIssue, type ActionMenu, type ActionMenuItem } from '../formatters/json.js';

interface DailyOptions {
  json?: boolean;
}

export async function runDaily(options: DailyOptions): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    if (options.json) {
      outputJsonError('GitHub authentication required. Install GitHub CLI (https://cli.github.com/) and run "gh auth login", or set GITHUB_TOKEN.');
    } else {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Option 1 (Recommended): Install and authenticate GitHub CLI');
      console.error('  Install: https://cli.github.com/');
      console.error('  Then run: gh auth login');
      console.error('');
      console.error('Option 2: Set GITHUB_TOKEN environment variable');
      console.error('  export GITHUB_TOKEN="your-github-token-here"');
    }
    process.exit(1);
  }

  try {
    await runDailyInner(token, options);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (options.json) {
      outputJsonError(`Daily check failed: ${msg}`);
    } else {
      console.error(`[FATAL] Daily check failed: ${msg}`);
      if (error instanceof Error && error.stack) {
        console.error(error.stack);
      }
    }
    process.exit(1);
  }
}

async function runDailyInner(token: string, options: DailyOptions): Promise<void> {
  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);

  // Fetch all open PRs fresh from GitHub
  const { prs, failures } = await prMonitor.fetchUserOpenPRs();

  // Log any failures (but continue with successful checks)
  if (failures.length > 0) {
    console.error(`Warning: ${failures.length} PR fetch(es) failed`);
  }

  // Fetch merged PR counts, closed PR counts, recently closed PRs, and commented issues in parallel
  const issueMonitor = new IssueConversationMonitor(token);
  const [mergedResult, closedResult, recentlyClosedPRs, issueConversationResult] = await Promise.all([
    prMonitor.fetchUserMergedPRCounts(),
    prMonitor.fetchUserClosedPRCounts(),
    prMonitor.fetchRecentlyClosedPRs(),
    issueMonitor.fetchCommentedIssues().catch(error => {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('No GitHub username configured')) {
        console.error(`[DAILY] Issue conversation tracking requires setup: ${msg}`);
      } else {
        console.error(`[DAILY] Issue conversation fetch failed: ${msg}`);
      }
      return { issues: [] as CommentedIssue[], failures: [{ issueUrl: 'N/A', error: `Issue conversation fetch failed: ${msg}` }] };
    }),
  ]);

  const commentedIssues = issueConversationResult.issues;
  if (issueConversationResult.failures.length > 0) {
    console.error(`[DAILY] ${issueConversationResult.failures.length} issue conversation check(s) failed`);
  }

  const { repos: mergedCounts, monthlyCounts, monthlyOpenedCounts: openedFromMerged } = mergedResult;
  const { repos: closedCounts, monthlyCounts: monthlyClosedCounts, monthlyOpenedCounts: openedFromClosed } = closedResult;

  // Reset stale repos first (so excluded/removed repos get zeroed).
  // Guard: if the API returned zero results but we have existing repos with merged PRs,
  // skip the reset to avoid wiping scores due to transient API failures.
  const existingReposWithMerges = Object.values(stateManager.getState().repoScores)
    .filter(s => s.mergedPRCount > 0);
  if (mergedCounts.size === 0 && existingReposWithMerges.length > 0) {
    console.error(`[DAILY] Skipping stale repo reset: API returned 0 merged PR results but state has ${existingReposWithMerges.length} repo(s) with merges. Possible API issue.`);
  } else {
    for (const score of Object.values(stateManager.getState().repoScores)) {
      if (!mergedCounts.has(score.repo)) {
        stateManager.updateRepoScore(score.repo, { mergedPRCount: 0 });
      }
    }
  }

  // Update merged/closed counts with per-repo error isolation (matches signal/trust loops below)
  let mergedCountFailures = 0;
  for (const [repo, { count, lastMergedAt }] of mergedCounts) {
    try {
      stateManager.updateRepoScore(repo, { mergedPRCount: count, lastMergedAt: lastMergedAt || undefined });
    } catch (error) {
      mergedCountFailures++;
      console.error(`[DAILY] Failed to update merged count for ${repo}:`, error instanceof Error ? error.message : error);
    }
  }
  if (mergedCountFailures === mergedCounts.size && mergedCounts.size > 0) {
    console.error(`[DAILY_ALL_MERGED_COUNT_UPDATES_FAILED] All ${mergedCounts.size} merged count update(s) failed.`);
  }

  // Populate closedWithoutMergeCount in repo scores.
  // Diagnostic: warn if API returned empty but we have known closed PRs (possible transient API failure).
  // Unlike merged counts above, there is no stale-reset loop for closed counts, so no skip is needed.
  const existingReposWithClosed = Object.values(stateManager.getState().repoScores)
    .filter(s => (s.closedWithoutMergeCount || 0) > 0);
  if (closedCounts.size === 0 && existingReposWithClosed.length > 0) {
    console.error(`[DAILY] Warning: API returned 0 closed PR results but state has ${existingReposWithClosed.length} repo(s) with closed PRs. Possible transient API issue.`);
  }
  let closedCountFailures = 0;
  for (const [repo, count] of closedCounts) {
    try {
      stateManager.updateRepoScore(repo, { closedWithoutMergeCount: count });
    } catch (error) {
      closedCountFailures++;
      console.error(`[DAILY] Failed to update closed count for ${repo}:`, error instanceof Error ? error.message : error);
    }
  }
  if (closedCountFailures === closedCounts.size && closedCounts.size > 0) {
    console.error(`[DAILY_ALL_CLOSED_COUNT_UPDATES_FAILED] All ${closedCounts.size} closed count update(s) failed.`);
  }

  // Update repo signals from observed open PR data (responsiveness, active maintainers).
  // Only repos with current open PRs get signal updates — repos with no open PRs
  // preserve their existing signals to avoid degrading scores when PRs are merged.
  // Per-repo try-catch: signal/trust syncing is secondary to the daily digest —
  // a single corrupted repo score should not prevent updates to other repos.
  const repoSignals = computeRepoSignals(prs);
  let signalUpdateFailures = 0;
  for (const [repo, signals] of repoSignals) {
    try {
      stateManager.updateRepoScore(repo, { signals });
    } catch (error) {
      signalUpdateFailures++;
      console.error(`[DAILY] Failed to update signals for ${repo}:`, error instanceof Error ? error.message : error);
    }
  }
  if (signalUpdateFailures === repoSignals.size && repoSignals.size > 0) {
    console.error(`[DAILY_ALL_SIGNAL_UPDATES_FAILED] All ${repoSignals.size} signal update(s) failed. This may indicate corrupted state.`);
  }

  // Auto-sync trustedProjects from repos with merged PRs
  let trustSyncFailures = 0;
  for (const [repo] of mergedCounts) {
    try {
      stateManager.addTrustedProject(repo);
    } catch (error) {
      trustSyncFailures++;
      console.error(`[DAILY] Failed to sync trusted project ${repo}:`, error instanceof Error ? error.message : error);
    }
  }
  if (trustSyncFailures === mergedCounts.size && mergedCounts.size > 0) {
    console.error(`[DAILY_ALL_TRUST_SYNCS_FAILED] All ${mergedCounts.size} trusted project sync(s) failed. This may indicate corrupted state.`);
  }

  // Store monthly chart data (non-critical — each metric isolated so partial failures don't leave inconsistent state)
  try {
    stateManager.setMonthlyMergedCounts(monthlyCounts);
  } catch (error) {
    console.error('[DAILY] Failed to store monthly merged counts:', error instanceof Error ? error.message : error);
  }

  try {
    stateManager.setMonthlyClosedCounts(monthlyClosedCounts);
  } catch (error) {
    console.error('[DAILY] Failed to store monthly closed counts:', error instanceof Error ? error.message : error);
  }

  try {
    // Build combined monthly opened counts from merged + closed + currently-open PRs
    const combinedOpenedCounts: Record<string, number> = { ...openedFromMerged };
    for (const [month, count] of Object.entries(openedFromClosed)) {
      combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + count;
    }
    // Add currently-open PR creation dates
    for (const pr of prs) {
      if (pr.createdAt) {
        const month = pr.createdAt.slice(0, 7);
        combinedOpenedCounts[month] = (combinedOpenedCounts[month] || 0) + 1;
      }
    }
    stateManager.setMonthlyOpenedCounts(combinedOpenedCounts);
  } catch (error) {
    console.error('[DAILY] Failed to compute/store monthly opened counts:', error instanceof Error ? error.message : error);
  }

  // Generate digest from fresh data
  const digest = prMonitor.generateDigest(prs, recentlyClosedPRs);

  // Store digest in state so dashboard can render it
  stateManager.setLastDigest(digest);

  // Save state (updates lastRunAt, lastDigest)
  stateManager.save();

  // Assess capacity for new work
  const capacity = assessCapacity(prs, stateManager.getState().config.maxActivePRs);

  if (options.json) {
    // Include pre-formatted summary for Claude to display verbatim
    const issueResponses = commentedIssues.filter(i => i.status === 'new_response');
    const summary = formatSummary(digest, capacity, issueResponses);
    // New action-first flow fields
    const actionableIssues = collectActionableIssues(prs, recentlyClosedPRs);
    const briefSummary = formatBriefSummary(digest, actionableIssues.length, issueResponses.length);
    const actionMenu = computeActionMenu(actionableIssues, capacity, issueResponses);
    // Group PRs by repo for safe parallel dispatch (#80)
    const repoGroups = groupPRsByRepo(prs);
    outputJson<DailyOutput>({ digest, updates: [], capacity, summary, briefSummary, actionableIssues, actionMenu, commentedIssues, repoGroups, failures });
  } else {
    // Simple console output for non-JSON mode
    printDigest(digest, capacity, commentedIssues);
  }
}

/**
 * Format summary as markdown (used in JSON output for Claude to display verbatim)
 */
function formatSummary(digest: DailyDigest, capacity: CapacityAssessment, issueResponses: CommentedIssue[] = []): string {
  const lines: string[] = [];

  // Header
  lines.push('## OSS Dashboard');
  lines.push('');
  lines.push(`📊 **${digest.summary.totalActivePRs} Active PRs** | ${digest.summary.totalMergedAllTime} Merged | ${digest.summary.mergeRate}% Merge Rate`);
  lines.push('✓ Dashboard generated — say "open dashboard" to view in browser');
  lines.push('');

  // CI Failing
  if (digest.ciFailingPRs.length > 0) {
    lines.push('### ❌ CI Failing');
    for (const pr of digest.ciFailingPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      if (pr.failingCheckNames.length > 0) {
        lines.push(`  └─ Failing: ${pr.failingCheckNames.join(', ')}`);
      }
    }
    lines.push('');
  }

  // Merge Conflicts
  if (digest.mergeConflictPRs.length > 0) {
    lines.push('### ⚠️ Merge Conflicts');
    for (const pr of digest.mergeConflictPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  // Needs Response
  if (digest.prsNeedingResponse.length > 0) {
    lines.push('### 💬 Needs Response');
    for (const pr of digest.prsNeedingResponse) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ @${maintainer} commented`);
      if (pr.maintainerActionHints.length > 0) {
        const hintLabels = pr.maintainerActionHints.map(formatActionHint).join(', ');
        lines.push(`  └─ Action: ${hintLabels}`);
      }
    }
    lines.push('');
  }

  // Needs Changes (review requested changes, no new commits yet)
  if (digest.needsChangesPRs.length > 0) {
    lines.push('### 🔧 Needs Changes');
    for (const pr of digest.needsChangesPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ Review requested changes — push commits to address`);
    }
    lines.push('');
  }

  // Incomplete Checklist
  if (digest.incompleteChecklistPRs.length > 0) {
    lines.push('### 📋 Incomplete Checklist');
    for (const pr of digest.incompleteChecklistPRs) {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total} checked)` : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${stats}`);
    }
    lines.push('');
  }

  // Changes Addressed (waiting for maintainer re-review)
  if (digest.changesAddressedPRs.length > 0) {
    lines.push('### 📤 Changes Addressed');
    for (const pr of digest.changesAddressedPRs) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ Waiting for @${maintainer} to re-review`);
    }
    lines.push('');
  }

  // Approaching Dormant
  if (digest.approachingDormant.length > 0) {
    lines.push('### ⏰ Approaching Dormant');
    for (const pr of digest.approachingDormant) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.daysSinceActivity} days)`);
    }
    lines.push('');
  }

  // Dormant
  if (digest.dormantPRs.length > 0) {
    lines.push('### 💤 Dormant');
    for (const pr of digest.dormantPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.daysSinceActivity} days)`);
    }
    lines.push('');
  }

  // Waiting on Maintainer (approved, no action needed from user)
  if (digest.waitingOnMaintainerPRs.length > 0) {
    lines.push('### ⏳ Waiting on Maintainer');
    for (const pr of digest.waitingOnMaintainerPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (approved)`);
    }
    lines.push('');
  }

  // Healthy PRs
  if (digest.healthyPRs.length > 0) {
    lines.push('### ✅ Healthy');
    for (const pr of digest.healthyPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  // Recently Closed (closed without merge)
  if (digest.recentlyClosedPRs.length > 0) {
    lines.push('### 🚫 Recently Closed');
    for (const pr of digest.recentlyClosedPRs) {
      const closedDate = pr.closedAt ? new Date(pr.closedAt).toLocaleDateString() : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${closedDate ? ` (closed ${closedDate})` : ''}`);
    }
    lines.push('');
  }

  // Issue Replies
  if (issueResponses.length > 0) {
    lines.push('### 💬 Issue Replies');
    for (const issue of issueResponses) {
      lines.push(`- [${issue.repo}#${issue.number}](${issue.url}): ${issue.title}`);
      if (issue.lastResponseAuthor && issue.lastResponseBody) {
        const timeAgo = issue.lastResponseAt ? formatRelativeTime(issue.lastResponseAt) : '';
        lines.push(`  └─ @${issue.lastResponseAuthor}: "${issue.lastResponseBody.slice(0, 80)}${issue.lastResponseBody.length > 80 ? '...' : ''}"${timeAgo ? ` (${timeAgo})` : ''}`);
      }
    }
    lines.push('');
  }

  // Capacity
  const capacityIcon = capacity.hasCapacity ? '✅' : '⚠️';
  const capacityLabel = capacity.hasCapacity ? 'Ready for new work' : 'Focus on existing PRs';
  lines.push(`**Capacity:** ${capacityIcon} ${capacityLabel} (${capacity.activePRCount}/${capacity.maxActivePRs} PRs)`);

  return lines.join('\n');
}

/**
 * Print digest to console (simple text output)
 */
function printDigest(digest: DailyDigest, capacity: CapacityAssessment, commentedIssues: CommentedIssue[] = []): void {
  console.log('\n📊 OSS Daily Check\n');
  console.log(`Active PRs: ${digest.summary.totalActivePRs}`);
  console.log(`Needing Attention: ${digest.summary.totalNeedingAttention}`);
  console.log(`Merged (all time): ${digest.summary.totalMergedAllTime}`);
  console.log(`Merge Rate: ${digest.summary.mergeRate}%`);
  console.log(`\nCapacity: ${capacity.hasCapacity ? '✅ Ready for new work' : '⚠️  Focus on existing work'}`);
  console.log(`  ${capacity.reason}\n`);

  if (digest.ciFailingPRs.length > 0) {
    console.log('❌ CI Failing:');
    for (const pr of digest.ciFailingPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      if (pr.failingCheckNames.length > 0) {
        console.log(`    Failing: ${pr.failingCheckNames.join(', ')}`);
      }
    }
    console.log('');
  }

  if (digest.mergeConflictPRs.length > 0) {
    console.log('⚠️ Merge Conflicts:');
    for (const pr of digest.mergeConflictPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  if (digest.prsNeedingResponse.length > 0) {
    console.log('💬 Needs Response:');
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
    console.log('🔧 Needs Changes:');
    for (const pr of digest.needsChangesPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    Review requested changes — push commits to address`);
    }
    console.log('');
  }

  if (digest.incompleteChecklistPRs.length > 0) {
    console.log('📋 Incomplete Checklist:');
    for (const pr of digest.incompleteChecklistPRs) {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total} checked)` : '';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}${stats}`);
    }
    console.log('');
  }

  if (digest.changesAddressedPRs.length > 0) {
    console.log('📤 Changes Addressed:');
    for (const pr of digest.changesAddressedPRs) {
      const maintainer = pr.lastMaintainerComment?.author || 'maintainer';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    Waiting for @${maintainer} to re-review`);
    }
    console.log('');
  }

  if (digest.approachingDormant.length > 0) {
    console.log('⏰ Approaching Dormant:');
    for (const pr of digest.approachingDormant) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title} (${pr.daysSinceActivity} days)`);
    }
    console.log('');
  }

  if (digest.dormantPRs.length > 0) {
    console.log('💤 Dormant:');
    for (const pr of digest.dormantPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title} (${pr.daysSinceActivity} days)`);
    }
    console.log('');
  }

  if (digest.waitingOnMaintainerPRs.length > 0) {
    console.log('⏳ Waiting on Maintainer:');
    for (const pr of digest.waitingOnMaintainerPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title} (approved)`);
    }
    console.log('');
  }

  if (digest.recentlyClosedPRs.length > 0) {
    console.log('🚫 Recently Closed:');
    for (const pr of digest.recentlyClosedPRs) {
      const closedDate = pr.closedAt ? new Date(pr.closedAt).toLocaleDateString() : '';
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}${closedDate ? ` (closed ${closedDate})` : ''}`);
    }
    console.log('');
  }

  const issueResponses = commentedIssues.filter(i => i.status === 'new_response');
  if (issueResponses.length > 0) {
    console.log('💬 Issue Replies:');
    for (const issue of issueResponses) {
      console.log(`  - ${issue.repo}#${issue.number}: ${issue.title}`);
      if (issue.lastResponseAuthor) {
        console.log(`    @${issue.lastResponseAuthor}: ${(issue.lastResponseBody || '').slice(0, 80)}${(issue.lastResponseBody || '').length > 80 ? '...' : ''}`);
      }
    }
    console.log('');
  }

  console.log('Run with --json for structured output');
  console.log('Run "dashboard --open" for browser view');
}

/**
 * Assess whether user has capacity for new issues
 */
function assessCapacity(prs: FetchedPR[], maxActivePRs: number): CapacityAssessment {
  const activePRCount = prs.length;

  // Count critical issues
  const criticalStatuses = new Set(['needs_response', 'needs_changes', 'failing_ci', 'merge_conflict']);
  const criticalIssueCount = prs.filter(pr => criticalStatuses.has(pr.status)).length;

  // Has capacity if: under PR limit AND no critical issues
  const underPRLimit = activePRCount < maxActivePRs;
  const noCriticalIssues = criticalIssueCount === 0;
  const hasCapacity = underPRLimit && noCriticalIssues;

  // Generate reason
  let reason: string;
  if (hasCapacity) {
    reason = `You have capacity: ${activePRCount}/${maxActivePRs} active PRs, no critical issues`;
  } else {
    const reasons: string[] = [];
    if (!underPRLimit) {
      reasons.push(`at PR limit (${activePRCount}/${maxActivePRs})`);
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
    criticalIssueCount,
    reason,
  };
}

/**
 * Format a brief one-liner summary for the action-first flow
 */
function formatBriefSummary(digest: DailyDigest, issueCount: number, issueResponseCount: number = 0): string {
  const attentionText = issueCount > 0
    ? `${issueCount} need${issueCount === 1 ? 's' : ''} attention`
    : 'all healthy';
  const issueReplyText = issueResponseCount > 0
    ? ` | ${issueResponseCount} issue repl${issueResponseCount === 1 ? 'y' : 'ies'}`
    : '';
  return `📊 ${digest.summary.totalActivePRs} Active PRs | ${attentionText}${issueReplyText} | Dashboard opened in browser`;
}

/**
 * Collect all actionable issues across PRs for the action-first flow
 * Order: Needs response → Needs changes → CI failing → Merge conflicts → Incomplete checklist → Approaching dormant → Recently closed
 */
function collectActionableIssues(prs: FetchedPR[], recentlyClosedPRs: ClosedPR[] = []): ActionableIssue[] {
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
  for (const pr of prs) {
    if (pr.status === 'failing_ci') {
      const checkInfo = pr.failingCheckNames.length > 0
        ? ` (${pr.failingCheckNames.join(', ')})`
        : '';
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

  // 6. Approaching Dormant
  for (const pr of prs) {
    if (pr.status === 'approaching_dormant') {
      issues.push({ type: 'approaching_dormant', pr, label: '[Approaching Dormant]' });
    }
  }

  // 7. Recently Closed (informational - PRs closed without merge in last 7 days)
  for (const closedPR of recentlyClosedPRs) {
    // Create a minimal FetchedPR-like object for the ActionableIssue interface
    const pr: FetchedPR = {
      id: 0,
      url: closedPR.url,
      repo: closedPR.repo,
      number: closedPR.number,
      title: closedPR.title,
      status: 'healthy', // placeholder
      displayLabel: '[Recently Closed]',
      displayDescription: `Closed without merge${closedPR.closedAt ? ` on ${new Date(closedPR.closedAt).toLocaleDateString()}` : ''}`,
      createdAt: '',
      updatedAt: closedPR.closedAt || '',
      daysSinceActivity: 0,
      ciStatus: 'unknown',
      failingCheckNames: [],
      classifiedChecks: [],
      hasMergeConflict: false,
      reviewDecision: 'unknown',
      hasUnrespondedComment: false,
      hasIncompleteChecklist: false,
      maintainerActionHints: [],
    };
    issues.push({ type: 'recently_closed', pr, label: '[Recently Closed]' });
  }

  return issues;
}

/**
 * Format a maintainer action hint as a human-readable label
 */
function formatActionHint(hint: MaintainerActionHint): string {
  switch (hint) {
    case 'demo_requested': return 'demo/screenshot requested';
    case 'tests_requested': return 'tests requested';
    case 'changes_requested': return 'code changes requested';
    case 'docs_requested': return 'documentation requested';
    case 'rebase_requested': return 'rebase requested';
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
  issueResponses: CommentedIssue[] = [],
): ActionMenu {
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

  // Slot for issue-list options — the orchestration layer may insert items here
  // (index after address_all/issue_replies when present, index 0 otherwise).
  // See commands/oss.md Step 3 for the insertion logic.

  if (capacity.hasCapacity) {
    items.push({
      key: 'search',
      label: 'Search for new issues',
      description: 'Look for new contribution opportunities',
    });
  } else if (!hasActionableIssues) {
    // When no actionable issues and no capacity, offer status details
    items.push({
      key: 'view_details',
      label: 'View PR status details',
      description: 'See full status of all tracked PRs',
    });
  } else {
    items.push({
      key: 'view_healthy',
      label: 'View healthy PRs',
      description: 'See status of PRs not needing attention',
    });
  }

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

/** Statuses indicating active maintainer engagement (reviews, feedback, merges). */
const ACTIVE_MAINTAINER_STATUSES: Set<FetchedPRStatus> = new Set([
  'healthy', 'waiting_on_maintainer', 'changes_addressed', 'needs_response', 'needs_changes',
]);

/** Statuses indicating staleness — maintainer comments during these statuses don't count as responsive. */
const STALE_STATUSES: Set<FetchedPRStatus> = new Set([
  'dormant', 'approaching_dormant',
]);

/**
 * Build a map grouping PRs by repository, skipping PRs with empty repo fields.
 * Shared by groupPRsByRepo and computeRepoSignals.
 */
function buildRepoMap(prs: FetchedPR[], label: string): Map<string, FetchedPR[]> {
  const repoMap = new Map<string, FetchedPR[]>();
  for (const pr of prs) {
    if (!pr.repo) {
      console.warn(`[${label}] Skipping PR #${pr.number} (${pr.url}) with empty repo field`);
      continue;
    }
    const existing = repoMap.get(pr.repo) || [];
    existing.push(pr);
    repoMap.set(pr.repo, existing);
  }
  return repoMap;
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
    const isResponsive = repoPRs.some(pr =>
      pr.lastMaintainerComment && !STALE_STATUSES.has(pr.status)
    );
    const hasActiveMaintainers = repoPRs.some(pr =>
      ACTIVE_MAINTAINER_STATUSES.has(pr.status)
    );
    result.set(repo, { isResponsive, hasActiveMaintainers });
  }
  return result;
}

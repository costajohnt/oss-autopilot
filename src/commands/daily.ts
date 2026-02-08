/**
 * Daily check command
 * Fetches all open PRs fresh from GitHub and generates a digest
 * v2: No local state tracking - everything is fetched fresh
 */

import { getStateManager, PRMonitor, getGitHubToken, type DailyDigest, type FetchedPR, type PRCheckFailure, type MaintainerActionHint, type ClosedPR } from '../core/index.js';
import { outputJson, outputJsonError, type DailyOutput, type CapacityAssessment, type ActionableIssue } from '../formatters/json.js';

interface DailyOptions {
  json?: boolean;
}

export async function runDaily(options: DailyOptions): Promise<void> {
  const token = getGitHubToken();
  if (!token) {
    if (options.json) {
      outputJsonError('GitHub authentication required. Run "gh auth login" or set GITHUB_TOKEN.');
    } else {
      console.error('Error: GitHub authentication required.');
      console.error('');
      console.error('Options:');
      console.error('  1. Use gh CLI: gh auth login');
      console.error('  2. Set GITHUB_TOKEN environment variable');
    }
    process.exit(1);
  }

  const stateManager = getStateManager();
  const prMonitor = new PRMonitor(token);

  // Fetch all open PRs fresh from GitHub
  const { prs, failures } = await prMonitor.fetchUserOpenPRs();

  // Log any failures (but continue with successful checks)
  if (failures.length > 0) {
    console.error(`Warning: ${failures.length} PR fetch(es) failed`);
  }

  // Fetch merged PR counts, closed PR counts, and recently closed PRs in parallel
  const [mergedResult, closedCounts, recentlyClosedPRs] = await Promise.all([
    prMonitor.fetchUserMergedPRCounts(),
    prMonitor.fetchUserClosedPRCounts(),
    prMonitor.fetchRecentlyClosedPRs(),
  ]);

  const { repos: mergedCounts, monthlyCounts } = mergedResult;

  // Reset stale repos first (so excluded/removed repos get zeroed)
  for (const score of Object.values(stateManager.getState().repoScores)) {
    if (!mergedCounts.has(score.repo)) {
      stateManager.updateRepoScore(score.repo, { mergedPRCount: 0 });
    }
  }
  for (const [repo, { count, lastMergedAt }] of mergedCounts) {
    stateManager.updateRepoScore(repo, { mergedPRCount: count, lastMergedAt: lastMergedAt || undefined });
  }

  // Populate closedWithoutMergeCount in repo scores
  for (const [repo, count] of closedCounts) {
    stateManager.updateRepoScore(repo, { closedWithoutMergeCount: count });
  }

  // Store monthly merged counts for the contribution timeline chart
  stateManager.setMonthlyMergedCounts(monthlyCounts);

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
    const summary = formatSummary(digest, capacity);
    // New action-first flow fields
    const actionableIssues = collectActionableIssues(prs, recentlyClosedPRs);
    const briefSummary = formatBriefSummary(digest, actionableIssues.length);
    outputJson<DailyOutput>({ digest, updates: [], capacity, summary, briefSummary, actionableIssues, failures });
  } else {
    // Simple console output for non-JSON mode
    printDigest(digest, capacity);
  }
}

/**
 * Format summary as markdown (used in JSON output for Claude to display verbatim)
 */
function formatSummary(digest: DailyDigest, capacity: CapacityAssessment): string {
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

  // Capacity
  const capacityIcon = capacity.hasCapacity ? '✅' : '⚠️';
  const capacityLabel = capacity.hasCapacity ? 'Ready for new work' : 'Focus on existing PRs';
  lines.push(`**Capacity:** ${capacityIcon} ${capacityLabel} (${capacity.activePRCount}/${capacity.maxActivePRs} PRs)`);

  return lines.join('\n');
}

/**
 * Print digest to console (simple text output)
 */
function printDigest(digest: DailyDigest, capacity: CapacityAssessment): void {
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

  console.log('Run with --json for structured output');
  console.log('Run "dashboard --open" for browser view');
}

/**
 * Assess whether user has capacity for new issues
 */
function assessCapacity(prs: FetchedPR[], maxActivePRs: number): CapacityAssessment {
  const activePRCount = prs.length;

  // Count critical issues
  const criticalStatuses = new Set(['needs_response', 'failing_ci', 'merge_conflict']);
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
function formatBriefSummary(digest: DailyDigest, issueCount: number): string {
  const attentionText = issueCount > 0
    ? `${issueCount} need${issueCount === 1 ? 's' : ''} attention`
    : 'all healthy';
  return `📊 ${digest.summary.totalActivePRs} Active PRs | ${attentionText} | Dashboard opened in browser`;
}

/**
 * Collect all actionable issues across PRs for the action-first flow
 * Order: Needs response → CI failing → Merge conflicts → Approaching dormant
 */
function collectActionableIssues(prs: FetchedPR[], recentlyClosedPRs: ClosedPR[] = []): ActionableIssue[] {
  const issues: ActionableIssue[] = [];

  // 1. Needs Response (highest priority - someone is waiting for you)
  for (const pr of prs) {
    if (pr.status === 'needs_response') {
      issues.push({ type: 'needs_response', pr, label: '[Needs Response]' });
    }
  }

  // 2. CI Failing (include check names so user can distinguish real CI from validation bots)
  for (const pr of prs) {
    if (pr.status === 'failing_ci') {
      const checkInfo = pr.failingCheckNames.length > 0
        ? ` (${pr.failingCheckNames.join(', ')})`
        : '';
      issues.push({ type: 'ci_failing', pr, label: `[CI Failing${checkInfo}]` });
    }
  }

  // 3. Merge Conflicts
  for (const pr of prs) {
    if (pr.status === 'merge_conflict') {
      issues.push({ type: 'merge_conflict', pr, label: '[Merge Conflict]' });
    }
  }

  // 4. Incomplete Checklist
  for (const pr of prs) {
    if (pr.status === 'incomplete_checklist') {
      const stats = pr.checklistStats ? ` (${pr.checklistStats.checked}/${pr.checklistStats.total})` : '';
      issues.push({ type: 'incomplete_checklist', pr, label: `[Incomplete Checklist${stats}]` });
    }
  }

  // 5. Approaching Dormant
  for (const pr of prs) {
    if (pr.status === 'approaching_dormant') {
      issues.push({ type: 'approaching_dormant', pr, label: '[Approaching Dormant]' });
    }
  }

  // 6. Recently Closed (informational - PRs closed without merge in last 7 days)
  for (const closedPR of recentlyClosedPRs) {
    // Create a minimal FetchedPR-like object for the ActionableIssue interface
    const pr: FetchedPR = {
      id: 0,
      url: closedPR.url,
      repo: closedPR.repo,
      number: closedPR.number,
      title: closedPR.title,
      status: 'healthy', // placeholder
      createdAt: '',
      updatedAt: closedPR.closedAt || '',
      daysSinceActivity: 0,
      ciStatus: 'unknown',
      failingCheckNames: [],
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

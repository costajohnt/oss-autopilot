/**
 * Daily check command
 * Monitors all tracked PRs and generates a digest
 */

import { getStateManager, PRMonitor, type PRUpdate, type DailyDigest, type TrackedPR, type CheckAllPRsResult, isTestUsername, detectGitHubUsername } from '../core/index.js';
import { outputJson, outputJsonError, type DailyOutput, type CapacityAssessment, type ActionableIssue } from '../formatters/json.js';

interface DailyOptions {
  json?: boolean;
}

export async function runDaily(options: DailyOptions): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    if (options.json) {
      outputJsonError('GITHUB_TOKEN environment variable is required');
    } else {
      console.error('Error: GITHUB_TOKEN environment variable is required');
    }
    process.exit(1);
  }

  const stateManager = getStateManager();
  const config = stateManager.getState().config;

  // Auto-detect and update username if it's missing or is a test value
  if (isTestUsername(config.githubUsername)) {
    const detected = detectGitHubUsername();
    if (detected) {
      console.error(`Auto-detected GitHub user: @${detected}`);
      stateManager.updateConfig({ githubUsername: detected });
    } else if (!config.githubUsername) {
      if (options.json) {
        outputJsonError('No GitHub username configured. Run: init <username>');
      } else {
        console.error('Error: No GitHub username configured.');
        console.error('Run: init <username>');
      }
      process.exit(1);
    }
  }

  const prMonitor = new PRMonitor(token);

  // First, sync PRs from GitHub (fetch new ones, detect closed ones)
  const syncResult = await prMonitor.syncPRs();

  if (!options.json && syncResult.added > 0) {
    console.log(`Found ${syncResult.added} new PRs`);
  }

  // Then check all PRs for updates
  const checkResult = await prMonitor.checkAllPRs();
  const { updates, failures } = checkResult;

  // Log any failures (but continue with successful checks)
  if (failures.length > 0) {
    console.error(`Warning: ${failures.length} PR check(s) failed`);
  }

  // Generate digest
  const digest = generateDigest(updates, stateManager);

  // Save state
  stateManager.save();

  // Assess capacity for new work
  const capacity = assessCapacity(stateManager, updates);

  if (options.json) {
    // Include pre-formatted summary for Claude to display verbatim (deprecated but kept for compatibility)
    const summary = formatSummary(digest, capacity);
    // New action-first flow fields
    const actionableIssues = collectActionableIssues(stateManager, digest);
    const briefSummary = formatBriefSummary(digest, actionableIssues.length);
    outputJson<DailyOutput>({ digest, updates, capacity, summary, briefSummary, actionableIssues });
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

  // Health Issues (CI failing, merge conflicts)
  const healthIssues = [...digest.prsNeedingResponse, ...digest.approachingDormant, ...digest.dormantPRs]
    .filter(pr => pr.ciStatus === 'failing' || pr.hasMergeConflict);
  if (healthIssues.length > 0) {
    lines.push('### ❌ Health Issues');
    for (const pr of healthIssues) {
      const issues = [];
      if (pr.ciStatus === 'failing') issues.push('CI failing');
      if (pr.hasMergeConflict) issues.push('merge conflict');
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ ${issues.join(', ')}`);
    }
    lines.push('');
  }

  // Merged PRs
  if (digest.mergedPRs.length > 0) {
    lines.push('### 🎉 Recently Merged');
    for (const pr of digest.mergedPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  // Needs Response
  if (digest.prsNeedingResponse.length > 0) {
    lines.push('### 💬 Needs Response');
    for (const pr of digest.prsNeedingResponse) {
      const status = pr.reviewDecision === 'approved' ? '✅ Approved' : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      if (status) lines.push(`  └─ ${status}`);
    }
    lines.push('');
  }

  // Approaching Dormant
  if (digest.approachingDormant.length > 0) {
    lines.push('### ⚠️ Approaching Dormant');
    for (const pr of digest.approachingDormant) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.daysSinceActivity} days)`);
    }
    lines.push('');
  }

  // Dormant
  if (digest.dormantPRs.length > 0) {
    lines.push('### ⏰ Dormant');
    for (const pr of digest.dormantPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.daysSinceActivity} days)`);
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
  console.log(`Merged: ${digest.summary.totalMergedAllTime}`);
  console.log(`Merge Rate: ${digest.summary.mergeRate}%`);
  console.log(`\nCapacity: ${capacity.hasCapacity ? '✅ Ready for new work' : '⚠️  Focus on existing work'}`);
  console.log(`  ${capacity.reason}\n`);

  if (digest.prsNeedingResponse.length > 0) {
    console.log('💬 Needs Response:');
    for (const pr of digest.prsNeedingResponse) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  if (digest.mergedPRs.length > 0) {
    console.log('🎉 Recently Merged:');
    for (const pr of digest.mergedPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  if (digest.approachingDormant.length > 0) {
    console.log('⚠️  Approaching Dormant:');
    for (const pr of digest.approachingDormant) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  if (digest.dormantPRs.length > 0) {
    console.log('⏰ Dormant:');
    for (const pr of digest.dormantPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
    }
    console.log('');
  }

  console.log('Run with --json for structured output');
  console.log('Run "dashboard --open" for browser view');
}

/**
 * Assess whether user has capacity for new issues
 * Critical issues: ci_failing, merge_conflict, new_comment, changes_requested
 */
function assessCapacity(
  stateManager: ReturnType<typeof getStateManager>,
  updates: PRUpdate[]
): CapacityAssessment {
  const state = stateManager.getState();
  const { maxActivePRs } = state.config;
  const activePRCount = state.activePRs.length;

  // Count critical issues from updates
  const criticalTypes = new Set(['new_comment', 'review', 'ci_failing', 'merge_conflict', 'changes_requested']);
  const criticalUpdates = updates.filter(u => criticalTypes.has(u.type));

  // Also count PRs that need response (may not have fresh updates)
  const prsNeedingResponse = state.activePRs.filter(pr => pr.hasUnreadComments || pr.activityStatus === 'needs_response');

  // Deduplicate: some PRs may have both an update and be in needsResponse
  const criticalPRUrls = new Set([
    ...criticalUpdates.map(u => u.pr.url),
    ...prsNeedingResponse.map(pr => pr.url),
  ]);
  const criticalIssueCount = criticalPRUrls.size;

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
 * Order: CI failing → Merge conflicts → Needs response → Approaching dormant
 */
function collectActionableIssues(
  stateManager: ReturnType<typeof getStateManager>,
  digest: DailyDigest
): ActionableIssue[] {
  const issues: ActionableIssue[] = [];
  const state = stateManager.getState();
  const seenUrls = new Set<string>();

  // Helper to add an issue if not already added
  const addIssue = (type: ActionableIssue['type'], pr: TrackedPR, label: string) => {
    if (!seenUrls.has(pr.url)) {
      seenUrls.add(pr.url);
      issues.push({ type, pr, label });
    }
  };

  // 1. CI Failing (highest priority)
  for (const pr of state.activePRs) {
    if (pr.ciStatus === 'failing') {
      addIssue('ci_failing', pr, '[CI Failing]');
    }
  }

  // 2. Merge Conflicts
  for (const pr of state.activePRs) {
    if (pr.hasMergeConflict && !seenUrls.has(pr.url)) {
      addIssue('merge_conflict', pr, '[Merge Conflict]');
    }
  }

  // 3. Needs Response
  for (const pr of digest.prsNeedingResponse) {
    if (!seenUrls.has(pr.url)) {
      addIssue('needs_response', pr, '[Needs Response]');
    }
  }

  // 4. Approaching Dormant
  for (const pr of digest.approachingDormant) {
    if (!seenUrls.has(pr.url)) {
      addIssue('approaching_dormant', pr, '[Approaching Dormant]');
    }
  }

  return issues;
}

function generateDigest(
  updates: PRUpdate[],
  stateManager: ReturnType<typeof getStateManager>
): DailyDigest {
  const state = stateManager.getState();
  const now = new Date().toISOString();

  const mergedPRs = updates.filter(u => u.type === 'merged').map(u => u.pr);
  const prsNeedingResponse = state.activePRs.filter(pr => pr.hasUnreadComments);
  const dormantPRs = updates.filter(u => u.type === 'dormant').map(u => u.pr);
  const approachingDormant = updates.filter(u => u.type === 'approaching_dormant').map(u => u.pr);

  const stats = stateManager.getStats();

  return {
    generatedAt: now,
    mergedPRs,
    prsNeedingResponse,
    dormantPRs,
    approachingDormant,
    newIssueCandidates: [],
    summary: {
      totalActivePRs: stats.activePRs,
      totalDormantPRs: stats.dormantPRs,
      totalMergedAllTime: stats.mergedPRs,
      mergeRate: parseFloat(stats.mergeRate),
    },
  };
}


/**
 * Rendering functions for the daily digest.
 *
 * Extracted from src/core/daily-logic.ts under #1117 so that
 * core/daily-logic.ts can be a pure-aggregations module with no console
 * or markdown output mixed in. The aggregations live in core because
 * other surfaces (dashboard, MCP) consume them too.
 *
 *   - formatActionHint — human-readable maintainer action hint label
 *   - formatBriefSummary — single-line status string
 *   - formatSummary — multi-line markdown summary
 *   - printDigest — console.log-based plain-text rendering
 *
 * Tests for these renderers live alongside the aggregations test
 * (daily-logic.test.ts) — pure rendering, easy to assert on string output.
 */

import { formatRelativeTime } from '../core/dates.js';
import type {
  CapacityAssessment,
  CommentedIssue,
  CommentedIssueWithResponse,
  DailyDigest,
  MaintainerActionHint,
} from '../core/types.js';

/**
 * Format a maintainer action hint as a human-readable label.
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
 * Format a brief one-liner summary for the action-first flow.
 *
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
 */
export function formatSummary(
  digest: DailyDigest,
  capacity: CapacityAssessment,
  issueResponses: CommentedIssueWithResponse[] = [],
): string {
  const lines: string[] = [];

  lines.push('## OSS Dashboard');
  lines.push('');
  lines.push(
    `\u{1F4CA} **${digest.summary.totalActivePRs} Active PRs** | ${digest.summary.totalMergedAllTime} Merged | ${digest.summary.mergeRate}% Merge Rate`,
  );
  lines.push('✓ Dashboard generated — say "open dashboard" to view in browser');
  lines.push('');

  if (digest.needsAddressingPRs.length > 0) {
    lines.push('### ❌ Needs Addressing');
    for (const pr of digest.needsAddressingPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ ${pr.displayLabel} ${pr.displayDescription}`);
    }
    lines.push('');
  }

  if (digest.waitingOnMaintainerPRs.length > 0) {
    lines.push('### ⏳ Waiting on Maintainer');
    for (const pr of digest.waitingOnMaintainerPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
      lines.push(`  └─ ${pr.displayDescription}`);
    }
    lines.push('');
  }

  if (digest.recentlyMergedPRs.length > 0) {
    lines.push('### \u{1F389} Recently Merged');
    for (const pr of digest.recentlyMergedPRs) {
      const mergedDate = pr.mergedAt ? new Date(pr.mergedAt).toLocaleDateString() : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${mergedDate ? ` (merged ${mergedDate})` : ''}`);
    }
    lines.push('');
  }

  if (digest.recentlyClosedPRs.length > 0) {
    lines.push('### \u{1F6AB} Recently Closed');
    for (const pr of digest.recentlyClosedPRs) {
      const closedDate = pr.closedAt ? new Date(pr.closedAt).toLocaleDateString() : '';
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}${closedDate ? ` (closed ${closedDate})` : ''}`);
    }
    lines.push('');
  }

  if (digest.autoUnshelvedPRs.length > 0) {
    lines.push('### \u{1F514} Auto-Unshelved');
    lines.push('> These PRs were shelved but a maintainer engaged — moved back to active.');
    for (const pr of digest.autoUnshelvedPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title} (${pr.status.replace(/_/g, ' ')})`);
    }
    lines.push('');
  }

  if (digest.shelvedPRs.length > 0) {
    lines.push('### \u{1F4E6} Shelved');
    for (const pr of digest.shelvedPRs) {
      lines.push(`- [${pr.repo}#${pr.number}](${pr.url}): ${pr.title}`);
    }
    lines.push('');
  }

  if (issueResponses.length > 0) {
    lines.push('### \u{1F4AC} Issue Replies');
    for (const issue of issueResponses) {
      lines.push(`- [${issue.repo}#${issue.number}](${issue.url}): ${issue.title}`);
      const timeAgo = formatRelativeTime(issue.lastResponseAt);
      lines.push(
        `  └─ @${issue.lastResponseAuthor}: "${issue.lastResponseBody.slice(0, 80)}${issue.lastResponseBody.length > 80 ? '...' : ''}"${timeAgo ? ` (${timeAgo})` : ''}`,
      );
    }
    lines.push('');
  }

  const capacityIcon = capacity.hasCapacity ? '✅' : '⚠️';
  const capacityLabel = capacity.hasCapacity ? 'Ready for new work' : 'Focus on existing PRs';
  const shelvedNote = capacity.shelvedPRCount > 0 ? ` + ${capacity.shelvedPRCount} shelved` : '';
  lines.push(
    `**Capacity:** ${capacityIcon} ${capacityLabel} (${capacity.activePRCount}/${capacity.maxActivePRs} PRs${shelvedNote})`,
  );

  return lines.join('\n');
}

/**
 * Print digest to console as plain text. Unified renderer: uses the same
 * section ordering as {@link formatSummary} but outputs plain text with
 * console.log instead of markdown links.
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
  console.log(`\nCapacity: ${capacity.hasCapacity ? '✅ Ready for new work' : '⚠️  Focus on existing work'}`);
  console.log(`  ${capacity.reason}\n`);

  if (digest.needsAddressingPRs.length > 0) {
    console.log('❌ Needs Addressing:');
    for (const pr of digest.needsAddressingPRs) {
      console.log(`  - ${pr.repo}#${pr.number}: ${pr.title}`);
      console.log(`    ${pr.displayLabel} ${pr.displayDescription}`);
    }
    console.log('');
  }

  if (digest.waitingOnMaintainerPRs.length > 0) {
    console.log('⏳ Waiting on Maintainer:');
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

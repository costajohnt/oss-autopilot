/**
 * Vet-list command (#764)
 * Re-vets all available issues in a curated issue list file via @oss-scout/core.
 */

import * as fs from 'fs';
import { createAutopilotScout } from './scout-bridge.js';
import { type VetListOutput, type VetOutput, type VetListItemStatus } from '../formatters/json.js';
import { runParseList, pruneIssueList } from './parse-list.js';
import { detectIssueList } from './startup.js';
import { computeSuccessGrade, gradeFromCandidate } from '../core/issue-grading.js';
import { getStateManager } from '../core/index.js';

const UNKNOWN_GRADE = computeSuccessGrade({ avgResponseDays: null, mergeRate: null, daysSinceLastCommit: null });

interface VetListOptions {
  issueListPath?: string;
  concurrency?: number;
  prune?: boolean;
}

/**
 * Determine the list status from vetting results.
 * Maps vetting recommendation + reasons to a list-level status.
 */
export function classifyListStatus(vetResult: VetOutput): VetListItemStatus {
  const skipReasons = vetResult.reasonsToSkip.map((r) => r.toLowerCase());

  if (skipReasons.some((r) => r.includes('closed'))) return 'closed';
  if (skipReasons.some((r) => r.includes('claimed') || r.includes('assigned'))) return 'claimed';
  if (skipReasons.some((r) => r.includes('existing pr') || r.includes('linked pr') || r.includes('pull request')))
    return 'has_pr';

  if (vetResult.recommendation === 'approve' || vetResult.recommendation === 'needs_review') {
    return 'still_available';
  }

  // Default: if skipped for other reasons, still mark as available
  // (the vetting result will show why it's not recommended)
  return 'still_available';
}

/**
 * Re-vet all available issues in a curated issue list.
 * Reads the list file, extracts available (non-done) issues,
 * and vets each in parallel with concurrency control.
 *
 * @param options - Vet-list options
 * @returns Consolidated vetting results with list status for each issue
 */
export async function runVetList(options: VetListOptions = {}): Promise<VetListOutput> {
  const concurrency = options.concurrency ?? 5;

  // 1. Find and parse the issue list
  let issueListPath = options.issueListPath;
  if (!issueListPath) {
    const detected = detectIssueList();
    if (!detected) {
      throw new Error('No issue list found. Provide a path with --path or configure issueListPath in settings.');
    }
    issueListPath = detected.path;
  }

  const parsed = await runParseList({ filePath: issueListPath });

  if (parsed.available.length === 0) {
    return {
      results: [],
      summary: { total: 0, stillAvailable: 0, claimed: 0, closed: 0, hasPR: 0, errors: 0 },
    };
  }

  // 2. Vet each available issue in parallel with concurrency limit
  const scout = await createAutopilotScout();
  const results: VetListOutput['results'] = [];

  // Simple concurrency limiter
  const items = parsed.available;
  let index = 0;

  async function processNext(): Promise<void> {
    while (index < items.length) {
      const item = items[index++];
      try {
        const candidate = await scout.vetIssue(item.url);
        const grade = gradeFromCandidate({
          repo: candidate.issue.repo,
          projectHealth: candidate.projectHealth,
          getRepoScore: (repo) => getStateManager().getRepoScore(repo),
        });
        const vetResult: VetOutput = {
          issue: {
            repo: candidate.issue.repo,
            number: candidate.issue.number,
            title: candidate.issue.title,
            url: candidate.issue.url,
            labels: candidate.issue.labels,
          },
          recommendation: candidate.recommendation,
          reasonsToApprove: candidate.reasonsToApprove,
          reasonsToSkip: candidate.reasonsToSkip,
          projectHealth: candidate.projectHealth,
          vettingResult: candidate.vettingResult,
          grade,
        };

        results.push({
          ...vetResult,
          listStatus: classifyListStatus(vetResult),
        });
      } catch (error) {
        // Per-issue errors don't fail the batch
        results.push({
          issue: { repo: item.repo, number: item.number, title: item.title, url: item.url, labels: [] },
          recommendation: 'skip',
          reasonsToApprove: [],
          reasonsToSkip: [`Error: ${error instanceof Error ? error.message : String(error)}`],
          projectHealth: {},
          vettingResult: {},
          grade: UNKNOWN_GRADE,
          listStatus: 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // Start `concurrency` workers
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => processNext());
  await Promise.all(workers);

  // 3. Compute summary
  const summary = {
    total: results.length,
    stillAvailable: results.filter((r) => r.listStatus === 'still_available').length,
    claimed: results.filter((r) => r.listStatus === 'claimed').length,
    closed: results.filter((r) => r.listStatus === 'closed').length,
    hasPR: results.filter((r) => r.listStatus === 'has_pr').length,
    errors: results.filter((r) => r.listStatus === 'error').length,
  };

  // 4. Prune the file if requested — remove completed/skipped/low-score items
  let pruneResult: { removedCount: number } | undefined;
  if (options.prune && issueListPath) {
    try {
      const content = fs.readFileSync(issueListPath, 'utf-8');
      const { pruned, removedCount } = pruneIssueList(content);
      if (pruned !== content) {
        fs.writeFileSync(issueListPath, pruned, 'utf-8');
      }
      pruneResult = { removedCount };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`Warning: Failed to prune ${issueListPath}: ${msg}`);
    }
  }

  return { results, summary, pruneResult };
}

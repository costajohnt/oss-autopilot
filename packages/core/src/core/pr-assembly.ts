/**
 * Shared PR assembly — turns normalized PR signals into a {@link FetchedPR}.
 *
 * Extracted from `PRMonitor.fetchPRDetails` (#1272 lineage) so the REST
 * enrichment path and the batched GraphQL enrichment path (`pr-graphql.ts`)
 * share ONE status-determination pipeline. Both paths normalize their raw
 * data into {@link PRSignals} and call {@link assembleFetchedPR}, which
 * guarantees the computed {@link FetchedPRStatus} (CI state, review decision,
 * merge conflicts, unresponded maintainer comments) is byte-for-byte identical
 * regardless of the transport used to fetch the data.
 */

import { daysBetween } from './dates.js';
import { FetchedPR, CIStatusResult } from './types.js';
import { determineStatus } from './status-determination.js';
import {
  type ReviewComment,
  determineReviewDecision,
  getLatestChangesRequestedDate,
  checkUnrespondedComments,
  getFirstMaintainerResponseAt,
} from './review-analysis.js';
import { analyzeChecklist } from './checklist-analysis.js';
import { extractMaintainerActionHints } from './maintainer-analysis.js';
import { categorizeCIStatus, classifyFailingChecks } from './ci-analysis.js';
import { computeDisplayLabel } from './display-utils.js';

/** Issue comment in the shape `checkUnrespondedComments`/`getFirstMaintainerResponseAt` read. */
export interface AssemblyComment {
  user?: { login?: string } | null;
  body?: string | null;
  created_at: string;
}

/** Submitted review in the shape the review-analysis helpers read. */
export interface AssemblyReview {
  user?: { login?: string } | null;
  body?: string | null;
  submitted_at?: string | null;
  state?: string | null;
  id?: number;
}

/**
 * Normalized, transport-agnostic PR signals consumed by {@link assembleFetchedPR}.
 * Produced by either the REST path (from `pulls.get` + list endpoints + CI
 * analysis) or the GraphQL path (from a batched query mapped back into these
 * REST-equivalent shapes).
 */
export interface PRSignals {
  prUrl: string;
  owner: string;
  repo: string;
  number: number;
  id: number;
  title: string;
  /** PR body; empty string when absent (matches REST `body || ''`). */
  body: string;
  createdAt: string;
  updatedAt: string;
  /** True when the PR has a merge conflict (REST `mergeable === false || mergeable_state === 'dirty'`). */
  hasMergeConflict: boolean;
  comments: AssemblyComment[];
  reviews: AssemblyReview[];
  reviewComments: ReviewComment[];
  ciStatus: CIStatusResult;
}

/** Config subset the assembly needs — the fields `determineStatus` and comment analysis consume. */
export interface AssemblyConfig {
  githubUsername: string;
  dormantThresholdDays: number;
  approachingDormantDays: number;
}

/** HEAD-commit metadata used to decide whether maintainer feedback has been addressed. */
export interface CommitInfo {
  date?: string;
  /** GitHub login of the HEAD commit author. */
  author?: string;
}

/**
 * Assemble a {@link FetchedPR} from normalized signals.
 *
 * `getCommitInfo` is invoked lazily — and only when the status logic actually
 * needs the HEAD commit date (an unresponded maintainer comment or a
 * changes-requested review). The REST path uses this to avoid an extra
 * `repos.getCommit` call; the GraphQL path already has the commit in the batch
 * and simply returns it. Because `determineStatus` consults the commit date
 * only in those same branches, always-providing it (GraphQL) versus
 * lazily-providing it (REST) yields an identical result.
 */
export async function assembleFetchedPR(
  signals: PRSignals,
  config: AssemblyConfig,
  getCommitInfo: () => Promise<CommitInfo | undefined>,
): Promise<FetchedPR> {
  const { comments, reviews, reviewComments } = signals;

  // Determine review decision (delegated to review-analysis module)
  const reviewDecision = determineReviewDecision(reviews);

  const mergeConflict = signals.hasMergeConflict;

  // Check if there's an unresponded maintainer comment (delegated to review-analysis module)
  const { hasUnrespondedComment, lastMaintainerComment } = checkUnrespondedComments(
    comments,
    reviews,
    reviewComments,
    config.githubUsername,
  );

  // Earliest maintainer response, computed from the comment/review timeline (#1461).
  const firstMaintainerResponseAt = getFirstMaintainerResponseAt(comments, reviews, config.githubUsername);

  // We need the commit date when hasUnrespondedComment is true (to distinguish
  // "needs_response" from "waiting_on_maintainer") OR when reviewDecision is
  // "changes_requested" (to detect needs_changes: review requested changes but
  // no new commits pushed). Fetched lazily so the REST path skips the call when
  // it isn't needed.
  const needCommitDate = hasUnrespondedComment || reviewDecision === 'changes_requested';
  const commitInfo = needCommitDate ? await getCommitInfo() : undefined;
  const latestCommitDate = commitInfo?.date;
  const latestCommitAuthor = commitInfo?.author;

  // Analyze PR body for incomplete checklists (delegated to checklist-analysis module)
  const { hasIncompleteChecklist, checklistStats } = analyzeChecklist(signals.body || '');

  // Extract maintainer action hints from comments (delegated to maintainer-analysis module)
  const maintainerActionHints = extractMaintainerActionHints(lastMaintainerComment?.body, reviewDecision);

  // Calculate days since activity
  const daysSinceActivity = daysBetween(new Date(signals.updatedAt), new Date());

  // Find the date of the latest changes_requested review (delegated to review-analysis module)
  const latestChangesRequestedDate = getLatestChangesRequestedDate(reviews);

  const { status: ciStatus, failingCheckNames, failingCheckConclusions } = signals.ciStatus;

  // Classify failing checks (delegated to ci-analysis module)
  const classifiedChecks = classifyFailingChecks(failingCheckNames, failingCheckConclusions);

  // Aggregate 5-state CI categorization (#1272).
  const ciCategorization = categorizeCIStatus({ ciStatus, failingCheckNames, classifiedChecks });

  // Determine status
  const hasActionableCIFailure = ciStatus === 'failing' && classifiedChecks.some((c) => c.category === 'actionable');
  const { status, actionReason, waitReason, stalenessTier, actionReasons } = determineStatus({
    ciStatus,
    hasMergeConflict: mergeConflict,
    hasUnrespondedComment,
    hasIncompleteChecklist,
    reviewDecision,
    daysSinceActivity,
    dormantThreshold: config.dormantThresholdDays,
    approachingThreshold: config.approachingDormantDays,
    latestCommitDate,
    latestCommitAuthor,
    contributorUsername: config.githubUsername,
    lastMaintainerCommentDate: lastMaintainerComment?.createdAt,
    latestChangesRequestedDate,
    hasActionableCIFailure,
  });

  const pr: FetchedPR = {
    id: signals.id,
    url: signals.prUrl,
    repo: `${signals.owner}/${signals.repo}`,
    number: signals.number,
    title: signals.title,
    status,
    actionReason,
    waitReason,
    stalenessTier,
    actionReasons,
    createdAt: signals.createdAt,
    updatedAt: signals.updatedAt,
    firstMaintainerResponseAt,
    daysSinceActivity,
    ciStatus,
    failingCheckNames,
    classifiedChecks,
    ciCategorization,
    hasMergeConflict: mergeConflict,
    reviewDecision,
    hasUnrespondedComment,
    lastMaintainerComment,
    latestCommitDate,
    hasIncompleteChecklist,
    checklistStats,
    maintainerActionHints,
    displayLabel: '', // computed below
    displayDescription: '', // computed below
  };

  // Compute display labels (#79) — delegated to display-utils module
  const { displayLabel, displayDescription } = computeDisplayLabel(pr);
  pr.displayLabel = displayLabel;
  pr.displayDescription = displayDescription;

  return pr;
}

/**
 * Dashboard type definitions.
 *
 * Shared types are re-exported from @oss-autopilot/core to prevent drift.
 * Dashboard-specific types (stats, API response shape, actions) are defined here.
 */

import type {
  FetchedPRStatus,
  ShelvedPRRef,
  FetchedPR,
  CommentedIssue,
  CommentedIssueWithResponse,
  MergedPR,
  ClosedPR,
  RepoMetadataEntry,
} from '@oss-autopilot/core/types';

import type {
  ParsedIssueItem,
  ParseIssueListOutput,
  DashboardStats,
  DashboardActionType,
  ActionRequest,
} from '@oss-autopilot/core/commands';

// Re-export shared types so consumers keep using `import { X } from '../types'`
export type {
  FetchedPRStatus,
  ShelvedPRRef,
  FetchedPR,
  CommentedIssue,
  CommentedIssueWithResponse,
  MergedPR,
  ClosedPR,
  RepoMetadataEntry,
  ParsedIssueItem,
  ParseIssueListOutput,
  DashboardStats,
  DashboardActionType,
  ActionRequest,
};

/** The shape of the GET /api/data response from the dashboard server. */
export interface DashboardData {
  stats: DashboardStats;
  prsByRepo: Record<string, { active: number; merged: number; closed: number }>;
  topRepos: Array<{ repo: string; active: number; merged: number; closed: number }>;
  monthlyMerged: Record<string, number>;
  monthlyOpened: Record<string, number>;
  monthlyClosed: Record<string, number>;
  activePRs: FetchedPR[];
  shelvedPRUrls: string[];
  recentlyMergedPRs: MergedPR[];
  recentlyClosedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
  allMergedPRs: MergedPR[];
  allClosedPRs: ClosedPR[];
  repoMetadata?: Record<string, RepoMetadataEntry>;
  vettedIssues?: ParseIssueListOutput | null;
  /**
   * Labels of non-critical sub-fetches that degraded to empty fallbacks
   * on the last refresh. Non-empty → UI should warn the user that slices
   * of the response are stale/zero'd rather than authoritative (#1035).
   */
  partialFailures?: string[];
}

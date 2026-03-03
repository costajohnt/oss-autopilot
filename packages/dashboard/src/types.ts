/**
 * Dashboard type definitions.
 *
 * Shared types are re-exported from @oss-autopilot/core to prevent drift.
 * Dashboard-specific types (stats, API response shape, actions) are defined here.
 */

import type {
  FetchedPRStatus,
  CIStatus,
  ReviewDecision,
  CIFailureCategory,
  MaintainerActionHint,
  IssueConversationStatus,
  ClassifiedCheck,
  ShelvedPRRef,
  FetchedPR,
  CommentedIssue,
  CommentedIssueWithResponse,
  MergedPR,
  ClosedPR,
} from '@oss-autopilot/core/types';

// Re-export shared types so consumers keep using `import { X } from '../types'`
export type {
  FetchedPRStatus,
  CIStatus,
  ReviewDecision,
  CIFailureCategory,
  MaintainerActionHint,
  IssueConversationStatus,
  ClassifiedCheck,
  ShelvedPRRef,
  FetchedPR,
  CommentedIssue,
  CommentedIssueWithResponse,
  MergedPR,
  ClosedPR,
};

// -- Dashboard-specific types --

export interface DashboardStats {
  activePRs: number;
  shelvedPRs: number;
  mergedPRs: number;
  closedPRs: number;
  mergeRate: string;
}

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
  dismissedUrls: string[];
  recentlyMergedPRs: MergedPR[];
  recentlyClosedPRs: ClosedPR[];
  autoUnshelvedPRs: ShelvedPRRef[];
  commentedIssues: CommentedIssue[];
  issueResponses: CommentedIssueWithResponse[];
}

/** Actions a user can take from the dashboard. */
export type ActionType = 'shelve' | 'unshelve' | 'snooze' | 'unsnooze' | 'dismiss' | 'undismiss';

/** Request body for POST /api/action. */
export interface ActionRequest {
  action: ActionType;
  url: string;
  reason?: string;
  days?: number;
}

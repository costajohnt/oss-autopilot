/**
 * JSON output formatter for CLI --json mode
 * Provides structured output that can be consumed by scripts and plugins
 */

import type { TrackedPR, DailyDigest, AgentState } from '../core/types.js';
import type { PRUpdate } from '../core/pr-monitor.js';

export interface JsonOutput<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

export interface CapacityAssessment {
  hasCapacity: boolean;
  activePRCount: number;
  maxActivePRs: number;
  criticalIssueCount: number;
  reason: string;
}

export type ActionableIssueType = 'ci_failing' | 'merge_conflict' | 'needs_response' | 'approaching_dormant';

export interface ActionableIssue {
  type: ActionableIssueType;
  pr: TrackedPR;
  label: string; // e.g., "[CI Failing]"
}

export interface DailyOutput {
  digest: DailyDigest;
  updates: PRUpdate[];
  capacity: CapacityAssessment;
  summary: string; // Pre-formatted markdown for Claude to display verbatim (deprecated, kept for compatibility)
  briefSummary: string; // One-liner for action-first flow
  actionableIssues: ActionableIssue[]; // Structured list for AskUserQuestion
}

export interface StatusOutput {
  stats: {
    activePRs: number;
    dormantPRs: number;
    mergedPRs: number;
    closedPRs: number;
    activeIssues: number;
    trustedProjects: number;
    mergeRate: string;
    needsResponse: number;
  };
  activePRs: TrackedPR[];
  dormantPRs: TrackedPR[];
  lastRunAt: string;
}

export interface SearchOutput {
  candidates: Array<{
    issue: {
      repo: string;
      number: number;
      title: string;
      url: string;
      labels: string[];
    };
    recommendation: 'approve' | 'skip' | 'needs_review';
    reasonsToApprove: string[];
    reasonsToSkip: string[];
  }>;
}

export interface TrackOutput {
  pr: TrackedPR;
}

export interface ConfigOutput {
  config: AgentState['config'];
}

/**
 * Wrap data in a standard JSON output envelope
 */
export function jsonSuccess<T>(data: T): JsonOutput<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Create an error JSON output
 */
export function jsonError(message: string): JsonOutput<never> {
  return {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Output JSON to stdout
 */
export function outputJson<T>(data: T): void {
  console.log(JSON.stringify(jsonSuccess(data), null, 2));
}

/**
 * Output error JSON to stdout (sets success: false)
 */
export function outputJsonError(message: string): void {
  console.log(JSON.stringify(jsonError(message), null, 2));
}

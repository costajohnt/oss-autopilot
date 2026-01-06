/**
 * Core types for the Open Source Contribution Agent
 */

export type PRStatus = 'open' | 'merged' | 'closed' | 'draft';
export type PRActivityStatus = 'active' | 'needs_response' | 'waiting' | 'dormant';
export type IssueStatus = 'candidate' | 'claimed' | 'in_progress' | 'pr_submitted';

export interface TrackedPR {
  // Identity
  id: number;
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;

  // Status
  status: PRStatus;
  activityStatus: PRActivityStatus;

  // Timestamps
  createdAt: string;
  updatedAt: string;
  lastChecked: string;
  mergedAt?: string;
  closedAt?: string;

  // Activity tracking
  lastActivityAt: string;
  daysSinceActivity: number;

  // Linked issue
  linkedIssueNumber?: number;

  // Pending actions
  hasUnreadComments: boolean;
  pendingResponse?: string; // Draft response awaiting approval

  // Metrics
  reviewCommentCount: number;
  commitCount: number;
}

export interface TrackedIssue {
  // Identity
  id: number;
  url: string;
  repo: string; // "owner/repo"
  number: number;
  title: string;

  // Status
  status: IssueStatus;

  // Metadata
  labels: string[];
  createdAt: string;
  updatedAt: string;

  // Vetting results
  vetted: boolean;
  vettingResult?: IssueVettingResult;

  // Linked PR
  linkedPRNumber?: number;
}

export interface IssueVettingResult {
  passedAllChecks: boolean;
  checks: {
    noExistingPR: boolean;
    notClaimed: boolean;
    projectActive: boolean;
    clearRequirements: boolean;
    contributionGuidelinesFound: boolean;
  };
  contributionGuidelines?: ContributionGuidelines;
  notes: string[];
}

export interface ContributionGuidelines {
  // From CONTRIBUTING.md
  branchNamingConvention?: string;
  commitMessageFormat?: string;
  prTitleFormat?: string;
  requiredChecks?: string[];

  // Testing requirements
  testFramework?: string;
  testCoverageRequired?: boolean;
  testFileNaming?: string;

  // Code style
  linter?: string;
  formatter?: string;
  styleGuideUrl?: string;

  // Process
  issueClaimProcess?: string;
  reviewProcess?: string;
  claRequired?: boolean;

  // Raw content for reference
  rawContent?: string;
}

export interface ProjectHealth {
  repo: string;
  lastCommitAt: string;
  daysSinceLastCommit: number;
  openIssuesCount: number;
  avgIssueResponseDays: number;
  ciStatus: 'passing' | 'failing' | 'unknown';
  isActive: boolean;
}

export interface DailyDigest {
  generatedAt: string;

  // PR updates
  mergedPRs: TrackedPR[];
  prsNeedingResponse: TrackedPR[];
  dormantPRs: TrackedPR[];
  approachingDormant: TrackedPR[]; // 25+ days

  // Issue candidates
  newIssueCandidates: TrackedIssue[];

  // Summary
  summary: {
    totalActivePRs: number;
    totalDormantPRs: number;
    totalMergedAllTime: number;
    mergeRate: number; // percentage
  };
}

export interface AgentState {
  // Version for migrations
  version: number;

  // Active work
  activePRs: TrackedPR[];
  activeIssues: TrackedIssue[];

  // Historical
  dormantPRs: TrackedPR[];
  mergedPRs: TrackedPR[];
  closedPRs: TrackedPR[];

  // Configuration
  config: AgentConfig;

  // Metadata
  lastRunAt: string;
  lastDigestAt?: string;
}

export interface AgentConfig {
  // Setup status
  setupComplete: boolean; // false until user completes initial setup
  setupCompletedAt?: string; // timestamp of when setup was completed

  // Limits
  maxActivePRs: number; // default 10
  dormantThresholdDays: number; // default 30
  approachingDormantDays: number; // default 25

  // Search preferences
  languages: string[]; // e.g., ["typescript", "javascript", "ruby"]
  labels: string[]; // e.g., ["good first issue", "help wanted"]
  excludeRepos: string[]; // repos to skip

  // Trusted projects (where we've had PRs merged)
  trustedProjects: string[];

  // GitHub username
  githubUsername: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  setupComplete: false,
  maxActivePRs: 10,
  dormantThresholdDays: 30,
  approachingDormantDays: 25,
  languages: ['typescript', 'javascript'],
  labels: ['good first issue', 'help wanted'],
  excludeRepos: [],
  trustedProjects: [],
  githubUsername: '',
};

export const INITIAL_STATE: AgentState = {
  version: 1,
  activePRs: [],
  activeIssues: [],
  dormantPRs: [],
  mergedPRs: [],
  closedPRs: [],
  config: DEFAULT_CONFIG,
  lastRunAt: new Date().toISOString(),
};

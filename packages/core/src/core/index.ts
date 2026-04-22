/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export {
  StateManager,
  getStateManager,
  getStateManagerAsync,
  ensureGistPersistence,
  maybeCheckpoint,
  resetStateManager,
  type Stats,
} from './state.js';
export { GistStateStore } from './gist-state-store.js';
export {
  PRMonitor,
  type PRCheckFailure,
  type FetchPRsResult,
  computeDisplayLabel,
  classifyCICheck,
  classifyFailingChecks,
} from './pr-monitor.js';
// Search/vetting now delegated to @oss-scout/core via commands/scout-bridge.ts
export { IssueConversationMonitor } from './issue-conversation.js';
export { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';
export { getOctokit, checkRateLimit, type RateLimitInfo } from './github.js';
export {
  parseGitHubUrl,
  daysBetween,
  splitRepo,
  isOwnRepo,
  getCLIVersion,
  getDataDir,
  getStatePath,
  getBackupDir,
  getCacheDir,
  formatRelativeTime,
  byDateDescending,
  getGitHubToken,
  getGitHubTokenAsync,
  requireGitHubToken,
  resetGitHubTokenCache,
  detectGitHubUsername,
  stateFileExists,
  DEFAULT_CONCURRENCY,
} from './utils.js';
export {
  OssAutopilotError,
  ConfigurationError,
  ValidationError,
  GistPermissionError,
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
  isRateLimitOrAuthError,
  nonFatalCatch,
  resolveErrorCode,
} from './errors.js';
export { enableDebug, isDebugEnabled, debug, info, warn, timed } from './logger.js';
export { HttpCache, getHttpCache, cachedRequest, type CacheEntry } from './http-cache.js';
export {
  CRITICAL_STATUSES,
  applyStatusOverrides,
  computeRepoSignals,
  groupPRsByRepo,
  assessCapacity,
  collectActionableIssues,
  computeActionMenu,
  toShelvedPRRef,
  formatActionHint,
  formatBriefSummary,
  formatSummary,
  printDigest,
} from './daily-logic.js';
export { computeContributionStats, type ContributionStats, type ComputeStatsInput } from './stats.js';
export { fetchPRTemplate, type PRTemplateResult } from './pr-template.js';
export {
  classifyLinkedPR,
  type LinkedPR,
  type LinkedPRClassification,
  type LinkedPRState,
} from './linked-pr-classification.js';
export {
  scanForAntiLLMPolicy,
  type AntiLLMCategory,
  type AntiLLMMatch,
  type AntiLLMScanResult,
} from './anti-llm-policy.js';
export {
  detectFormatters,
  diagnoseCIFormatterFailure,
  getPreferredFormatter,
  type DetectedFormatter,
  type FormatterDetectionResult,
  type CIFormatterDiagnosis,
  type FormatterName,
} from './formatter-detection.js';
export * from './types.js';

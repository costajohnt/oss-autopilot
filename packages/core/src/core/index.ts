/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export { StateManager, getStateManager, getStateManagerAsync, resetStateManager, type Stats } from './state.js';
export { GistStateStore } from './gist-state-store.js';
export {
  PRMonitor,
  type PRCheckFailure,
  type FetchPRsResult,
  computeDisplayLabel,
  classifyCICheck,
  classifyFailingChecks,
} from './pr-monitor.js';
export { IssueDiscovery } from './issue-discovery.js';
export { isDocOnlyIssue, applyPerRepoCap, DOC_ONLY_LABELS } from './issue-filtering.js';
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
  errorMessage,
  getHttpStatusCode,
  isRateLimitError,
  isRateLimitOrAuthError,
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
  detectFormatters,
  diagnoseCIFormatterFailure,
  getPreferredFormatter,
  type DetectedFormatter,
  type FormatterDetectionResult,
  type CIFormatterDiagnosis,
  type FormatterName,
} from './formatter-detection.js';
export * from './types.js';

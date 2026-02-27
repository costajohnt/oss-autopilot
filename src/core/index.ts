/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export { StateManager, getStateManager, resetStateManager } from './state.js';
export {
  PRMonitor,
  type PRCheckFailure,
  type FetchPRsResult,
  computeDisplayLabel,
  classifyCICheck,
  classifyFailingChecks,
} from './pr-monitor.js';
export {
  IssueDiscovery,
  type IssueCandidate,
  type SearchPriority,
  isDocOnlyIssue,
  applyPerRepoCap,
  DOC_ONLY_LABELS,
} from './issue-discovery.js';
export { IssueConversationMonitor } from './issue-conversation.js';
export { isBotAuthor, isAcknowledgmentComment } from './comment-utils.js';
export { getOctokit, checkRateLimit, type RateLimitInfo } from './github.js';
export {
  parseGitHubUrl,
  daysBetween,
  splitRepo,
  getDataDir,
  getStatePath,
  getBackupDir,
  getCacheDir,
  getDashboardPath,
  formatRelativeTime,
  byDateDescending,
  getGitHubToken,
  requireGitHubToken,
  resetGitHubTokenCache,
} from './utils.js';
export { enableDebug, isDebugEnabled, debug, warn, timed } from './logger.js';
export { HttpCache, getHttpCache, resetHttpCache, cachedRequest, type CacheEntry } from './http-cache.js';
export * from './types.js';

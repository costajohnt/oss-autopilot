/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export { StateManager, getStateManager, resetStateManager } from './state.js';
export { PRMonitor, type PRCheckFailure, type FetchPRsResult, computeDisplayLabel, classifyCICheck, classifyFailingChecks } from './pr-monitor.js';
export { IssueDiscovery, type IssueCandidate, type SearchPriority } from './issue-discovery.js';
export { getOctokit, checkRateLimit, type RateLimitInfo } from './github.js';
export {
  parseGitHubUrl,
  daysBetween,
  splitRepo,
  getDataDir,
  getStatePath,
  getBackupDir,
  getDashboardPath,
  formatRelativeTime,
  byDateDescending,
  getGitHubToken,
  requireGitHubToken,
  resetGitHubTokenCache,
} from './utils.js';
export * from './types.js';

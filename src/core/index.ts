/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export { StateManager, getStateManager, resetStateManager } from './state.js';
export { PRMonitor, type PRCheckFailure, type FetchPRsResult, type PRUpdate, type CheckAllPRsResult } from './pr-monitor.js';
export { IssueDiscovery, type IssueCandidate } from './issue-discovery.js';
export { getOctokit } from './github.js';
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

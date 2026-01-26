/**
 * Core module exports
 * Re-exports all core functionality for convenient imports
 */

export { StateManager, getStateManager, resetStateManager } from './state.js';
export { PRMonitor, type PRUpdate, type PRCheckFailure, type CheckAllPRsResult } from './pr-monitor.js';
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
} from './utils.js';
export * from './types.js';

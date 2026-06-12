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
  guidelinesFilename,
  repoFromGuidelinesFilename,
  GUIDELINES_FILE_PREFIX,
  GUIDELINES_MAX_BYTES,
  GuidelinesNotAvailableError,
  GuidelinesTooLargeError,
} from './guidelines-store.js';
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
export {
  wrapUntrustedContent,
  fenceFetchedPR,
  extractFromFence,
  safeExtractFromFence,
  UNTRUSTED_OPEN_TAG_NAME,
  UNTRUSTED_CLOSE_TAG,
  type UntrustedContentMeta,
} from './untrusted-content.js';
export { getOctokit, checkRateLimit, type RateLimitInfo } from './github.js';
export { parseGitHubUrl, splitRepo, isOwnRepo } from './urls.js';
export { daysBetween, formatRelativeTime, byDateDescending } from './dates.js';
export { getCLIVersion, getDataDir, getStatePath, getBackupDir, getCacheDir, stateFileExists } from './paths.js';
export {
  getGitHubToken,
  getGitHubTokenAsync,
  requireGitHubToken,
  resetGitHubTokenCache,
  detectGitHubUsername,
} from './auth.js';
export { DEFAULT_CONCURRENCY } from './concurrency.js';
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
  buildStarFilter,
  formatActionHint,
  formatBriefSummary,
  formatSummary,
  printDigest,
} from './daily-logic.js';
export { computeContributionStats, type ContributionStats, type ComputeStatsInput } from './stats.js';
export { fetchPRTemplate, type PRTemplateResult } from './pr-template.js';
export {
  classifyLinkedPR,
  isLinkedPRStalled,
  STALLED_PR_THRESHOLD_DAYS,
  type LinkedPR,
  type LinkedPRClassification,
  type LinkedPRState,
} from './linked-pr-classification.js';
export {
  classifyIssueAvailability,
  fetchIssueVerification,
  type IssueAvailabilityVerdict,
  type IssueVerification,
  type LinkedPRLinkType,
  type VerifiedLinkedPR,
  type VerifyIssueParams,
} from './issue-verification.js';
export {
  classifyAttentionBucket,
  summarizeAttentionBuckets,
  STUCK_CI_THRESHOLD_DAYS,
  DORMANT_FOLLOWUP_THRESHOLD_DAYS,
  type AttentionBucket,
  type AttentionInput,
  type AttentionSummary,
} from './pr-attention.js';
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
export {
  CONFIG_KEY_REGISTRY,
  type ConfigKeyDef,
  type SettableVia,
  isKnownKey,
  getKeyDef,
  getSetupKeys,
  getConfigKeys,
  suggestKey,
  formatUnknownKeyError,
} from './config-registry.js';
export {
  DashboardDataSchema,
  DashboardStatsSchema,
  validateDashboardData,
  type DashboardDataParsed,
} from './dashboard-data-schema.js';
// PR comment bundle types — wire shape consumed by the MCP extract-learnings
// prompt. Re-exported so MCP doesn't have to redeclare the interface and
// silently drift (#1208 M5).
export {
  fetchPRCommentBundle,
  fetchPRCommentBundlesBatch,
  type PRCommentBundle,
  type PRReviewEntry,
  type PRReviewCommentEntry,
  type PRIssueCommentEntry,
} from './pr-comments-fetcher.js';
export * from './types.js';

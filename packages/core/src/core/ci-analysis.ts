/**
 * CI Analysis - Classification and analysis of CI check runs and combined statuses.
 * Extracted from PRMonitor to isolate CI-related logic (#263).
 */

import type { Octokit } from '@octokit/rest';
import { CIFailureCategory, ClassifiedCheck, CIStatusResult } from './types.js';
import { getHttpStatusCode, errorMessage } from './errors.js';
import { debug, warn } from './logger.js';

/** Default CI status returned when no check data is available or an error occurs. */
const UNKNOWN_CI_STATUS: CIStatusResult = {
  status: 'unknown',
  failingCheckNames: [],
  failingCheckConclusions: new Map(),
};

/**
 * Known CI check name patterns that indicate fork limitations rather than real failures (#81).
 * These are deployment/preview services that require repo-level secrets unavailable in forks.
 */
const FORK_LIMITATION_PATTERNS: RegExp[] = [
  /vercel/i,
  /netlify/i,
  /\bpreview\s*deploy/i,
  /\bdeploy\s*preview/i,
  /storybook/i,
  /chromatic/i,
  /percy/i,
  /cloudflare pages/i,
  /\binternal\b/i,
];

/**
 * Known CI check name patterns that indicate authorization gates (#81).
 * These require maintainer approval and are not real failures.
 */
const AUTH_GATE_PATTERNS: RegExp[] = [/authoriz/i, /approval/i, /\bcla\b/i, /license\/cla/i];

/**
 * Known CI check name patterns that indicate infrastructure/transient failures (#145).
 * These are runner issues, dependency install problems, or service outages — not code failures.
 */
const INFRASTRUCTURE_PATTERNS: RegExp[] = [
  /\binstall\s*(os\s*)?dep(endenc|s\b)/i,
  /\bsetup\s+fail(ed|ure)?\b/i,
  /\bservice\s*unavailable/i,
  /\binfrastructure/i,
  /\bblacksmith\b/i,
];

/**
 * Classify a failing CI check as actionable, fork_limitation, auth_gate, or infrastructure (#81, #145).
 * Default is 'actionable' — only known patterns get reclassified.
 * When conclusion is provided (cancelled, timed_out), the check is classified as infrastructure.
 */
export function classifyCICheck(name: string, description?: string, conclusion?: string): CIFailureCategory {
  // Infrastructure: cancelled or timed_out jobs are transient failures (#145)
  if (conclusion === 'cancelled' || conclusion === 'timed_out') return 'infrastructure';

  const nameLower = name.toLowerCase();

  // Check name first (more reliable than description)
  if (AUTH_GATE_PATTERNS.some((p) => p.test(nameLower))) return 'auth_gate';
  if (FORK_LIMITATION_PATTERNS.some((p) => p.test(nameLower))) return 'fork_limitation';
  if (INFRASTRUCTURE_PATTERNS.some((p) => p.test(nameLower))) return 'infrastructure';

  // Fall through to description only if name was not classified
  if (description) {
    const descLower = description.toLowerCase();
    if (AUTH_GATE_PATTERNS.some((p) => p.test(descLower))) return 'auth_gate';
    if (FORK_LIMITATION_PATTERNS.some((p) => p.test(descLower))) return 'fork_limitation';
    if (INFRASTRUCTURE_PATTERNS.some((p) => p.test(descLower))) return 'infrastructure';
  }

  return 'actionable';
}

/**
 * Classify all failing checks and return both the flat names array and classified array (#81, #145).
 * Accepts optional conclusion data to detect infrastructure failures.
 */
export function classifyFailingChecks(
  failingCheckNames: string[],
  conclusions?: Map<string, string>,
): ClassifiedCheck[] {
  return failingCheckNames.map((name) => {
    const conclusion = conclusions?.get(name);
    return {
      name,
      category: classifyCICheck(name, undefined, conclusion),
      conclusion,
    };
  });
}

/**
 * Analyze check runs (GitHub Actions, etc.) and categorize them.
 * Returns flags for failing/pending/success and lists of failing check names + conclusions.
 */
export function analyzeCheckRuns(checkRuns: Array<{ name: string; conclusion: string | null; status: string }>): {
  hasFailingChecks: boolean;
  hasPendingChecks: boolean;
  hasSuccessfulChecks: boolean;
  failingCheckNames: string[];
  failingCheckConclusions: Map<string, string>;
} {
  let hasFailingChecks = false;
  let hasPendingChecks = false;
  let hasSuccessfulChecks = false;
  const failingCheckNames: string[] = [];
  const failingCheckConclusions = new Map<string, string>();

  for (const check of checkRuns) {
    if (check.conclusion === 'failure' || check.conclusion === 'cancelled' || check.conclusion === 'timed_out') {
      hasFailingChecks = true;
      failingCheckNames.push(check.name);
      failingCheckConclusions.set(check.name, check.conclusion);
    } else if (check.conclusion === 'action_required') {
      hasPendingChecks = true; // Maintainer approval gate, not a real failure
    } else if (check.status === 'in_progress' || check.status === 'queued') {
      hasPendingChecks = true;
    } else if (check.conclusion === 'success') {
      hasSuccessfulChecks = true;
    }
  }

  return { hasFailingChecks, hasPendingChecks, hasSuccessfulChecks, failingCheckNames, failingCheckConclusions };
}

/** Result shape from analyzeCheckRuns, used by mergeStatuses. */
interface CheckRunAnalysis {
  hasFailingChecks: boolean;
  hasPendingChecks: boolean;
  hasSuccessfulChecks: boolean;
  failingCheckNames: string[];
  failingCheckConclusions: Map<string, string>;
}

/** Result shape from analyzeCombinedStatus, used by mergeStatuses. */
interface CombinedStatusAnalysis {
  effectiveCombinedState: string;
  hasStatuses: boolean;
  failingStatusNames: string[];
}

/**
 * Analyze combined status API results (Travis, CircleCI, etc.).
 * Filters out authorization-gate statuses and determines the effective combined state.
 * Returns failing status context names in the result (does not mutate caller arrays).
 */
export function analyzeCombinedStatus(combinedStatus: {
  state: string;
  statuses: Array<{ state: string; context: string; description: string | null }>;
}): CombinedStatusAnalysis {
  // Filter out authorization-gate statuses (e.g., Vercel "Authorization required to deploy")
  // These are permission gates, not real CI failures
  const realStatuses = combinedStatus.statuses.filter((s) => {
    const desc = (s.description || '').toLowerCase();
    return !(s.state === 'failure' && (desc.includes('authorization required') || desc.includes('authorize')));
  });

  const hasRealFailure = realStatuses.some((s) => s.state === 'failure' || s.state === 'error');
  const hasRealPending = realStatuses.some((s) => s.state === 'pending');
  const hasRealSuccess = realStatuses.some((s) => s.state === 'success');

  let effectiveCombinedState: string;
  if (hasRealFailure) {
    effectiveCombinedState = 'failure';
  } else if (hasRealPending) {
    effectiveCombinedState = 'pending';
  } else if (hasRealSuccess) {
    effectiveCombinedState = 'success';
  } else if (realStatuses.length === 0) {
    // All statuses were auth gates; don't inherit original failure
    effectiveCombinedState = 'success';
  } else {
    effectiveCombinedState = combinedStatus.state;
  }
  const hasStatuses = combinedStatus.statuses.length > 0;

  // Collect failing status names from combined status API
  const failingStatusNames: string[] = [];
  for (const s of realStatuses) {
    if (s.state === 'failure' || s.state === 'error') {
      failingStatusNames.push(s.context);
    }
  }

  return { effectiveCombinedState, hasStatuses, failingStatusNames };
}

/**
 * Merge check run analysis and combined status analysis into a final CIStatusResult.
 * Priority: failing > pending > passing > unknown.
 */
export function mergeStatuses(
  checkRunAnalysis: CheckRunAnalysis,
  combinedAnalysis: CombinedStatusAnalysis,
  checkRunCount: number,
): CIStatusResult {
  const { hasFailingChecks, hasPendingChecks, hasSuccessfulChecks, failingCheckNames, failingCheckConclusions } =
    checkRunAnalysis;
  const { effectiveCombinedState, hasStatuses, failingStatusNames } = combinedAnalysis;

  // Merge failing names from both check runs and combined statuses
  const allFailingNames = [...failingCheckNames, ...failingStatusNames];

  // Safety net: If we have ANY failing checks, report as failing
  if (hasFailingChecks || effectiveCombinedState === 'failure' || effectiveCombinedState === 'error') {
    return { status: 'failing', failingCheckNames: allFailingNames, failingCheckConclusions };
  }

  if (hasPendingChecks || effectiveCombinedState === 'pending') {
    return { status: 'pending', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
    return { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  // No checks found at all — common for repos without CI
  if (!hasStatuses && checkRunCount === 0) {
    return UNKNOWN_CI_STATUS;
  }

  return UNKNOWN_CI_STATUS;
}

/**
 * Get CI status for a commit SHA by querying both the combined status API and check runs API.
 * Returns the merged status and names of any failing checks for diagnostics.
 */
export async function getCIStatus(octokit: Octokit, owner: string, repo: string, sha: string): Promise<CIStatusResult> {
  if (!sha) return UNKNOWN_CI_STATUS;

  try {
    // Fetch both combined status and check runs in parallel
    const [statusResponse, checksResponse] = await Promise.all([
      octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha }),
      // 404 is expected for repos without check runs configured; log other errors for debugging
      octokit.checks.listForRef({ owner, repo, ref: sha }).catch((err: unknown) => {
        const status = getHttpStatusCode(err);
        // Rate limit errors must propagate — matches listReviewComments pattern (#481)
        if (status === 429) throw err;
        if (status === 403) {
          const msg = errorMessage(err).toLowerCase();
          if (msg.includes('rate limit') || msg.includes('abuse detection')) throw err;
        }
        if (status === 404) {
          debug('pr-monitor', `Check runs 404 for ${owner}/${repo}@${sha.slice(0, 7)} (no checks configured)`);
        } else {
          warn(
            'pr-monitor',
            `Non-404 error fetching check runs for ${owner}/${repo}@${sha.slice(0, 7)}: ${status ?? err}`,
          );
        }
        return null;
      }),
    ]);

    const combinedStatus = statusResponse.data;
    const allCheckRuns = checksResponse?.data?.check_runs || [];

    // Deduplicate check runs by name, keeping only the most recent run per unique name.
    // GitHub returns all historical runs (including re-runs), so without deduplication
    // a superseded failure will incorrectly flag the PR as failing even after a re-run passes.
    const latestCheckRunsByName = new Map<string, (typeof allCheckRuns)[0]>();
    for (const check of allCheckRuns) {
      const existing = latestCheckRunsByName.get(check.name);
      if (!existing || new Date(check.started_at ?? 0) > new Date(existing.started_at ?? 0)) {
        latestCheckRunsByName.set(check.name, check);
      }
    }
    const checkRuns = [...latestCheckRunsByName.values()];

    const checkRunAnalysis = analyzeCheckRuns(checkRuns);
    const combinedAnalysis = analyzeCombinedStatus(combinedStatus);

    return mergeStatuses(checkRunAnalysis, combinedAnalysis, checkRuns.length);
  } catch (error) {
    const statusCode = getHttpStatusCode(error);

    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      throw error;
    } else if (statusCode === 404) {
      // Repo might not have CI configured, this is normal
      debug('pr-monitor', `CI check 404 for ${owner}/${repo} (no CI configured)`);
    } else {
      warn('pr-monitor', `Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage(error)}`);
    }
    return UNKNOWN_CI_STATUS;
  }
}

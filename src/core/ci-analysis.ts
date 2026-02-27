/**
 * CI Analysis - Classification and analysis of CI check runs and combined statuses.
 * Extracted from PRMonitor to isolate CI-related logic (#263).
 */

import { CIFailureCategory, ClassifiedCheck, CIStatusResult } from './types.js';

/**
 * Known CI check name patterns that indicate fork limitations rather than real failures (#81).
 * These are deployment/preview services that require repo-level secrets unavailable in forks.
 */
export const FORK_LIMITATION_PATTERNS: RegExp[] = [
  /vercel/i,
  /netlify/i,
  /\bpreview\s*deploy/i,
  /\bdeploy\s*preview/i,
  /storybook/i,
  /chromatic/i,
  /percy/i,
  /cloudflare pages/i,
];

/**
 * Known CI check name patterns that indicate authorization gates (#81).
 * These require maintainer approval and are not real failures.
 */
export const AUTH_GATE_PATTERNS: RegExp[] = [/authoriz/i, /approval/i, /\bcla\b/i, /license\/cla/i];

/**
 * Known CI check name patterns that indicate infrastructure/transient failures (#145).
 * These are runner issues, dependency install problems, or service outages — not code failures.
 */
export const INFRASTRUCTURE_PATTERNS: RegExp[] = [
  /\binstall\s*(os\s*)?dep(endenc|s\b)/i,
  /\bsetup\s+fail(ed|ure)?\b/i,
  /\bservice\s*unavailable/i,
  /\binfrastructure/i,
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
export interface CheckRunAnalysis {
  hasFailingChecks: boolean;
  hasPendingChecks: boolean;
  hasSuccessfulChecks: boolean;
  failingCheckNames: string[];
  failingCheckConclusions: Map<string, string>;
}

/** Result shape from analyzeCombinedStatus, used by mergeStatuses. */
export interface CombinedStatusAnalysis {
  effectiveCombinedState: string;
  hasStatuses: boolean;
}

/**
 * Analyze combined status API results (Travis, CircleCI, etc.).
 * Filters out authorization-gate statuses and determines the effective combined state.
 * Appends failing status context names to the provided failingCheckNames array.
 */
export function analyzeCombinedStatus(
  combinedStatus: { state: string; statuses: Array<{ state: string; context: string; description: string | null }> },
  failingCheckNames: string[],
): CombinedStatusAnalysis {
  // Filter out authorization-gate statuses (e.g., Vercel "Authorization required to deploy")
  // These are permission gates, not real CI failures
  const realStatuses = combinedStatus.statuses.filter((s) => {
    const desc = (s.description || '').toLowerCase();
    return !(s.state === 'failure' && (desc.includes('authorization required') || desc.includes('authorize')));
  });

  const hasRealFailure = realStatuses.some((s) => s.state === 'failure' || s.state === 'error');
  const hasRealPending = realStatuses.some((s) => s.state === 'pending');
  const hasRealSuccess = realStatuses.some((s) => s.state === 'success');
  const effectiveCombinedState = hasRealFailure
    ? 'failure'
    : hasRealPending
      ? 'pending'
      : hasRealSuccess
        ? 'success'
        : realStatuses.length === 0
          ? 'success' // All statuses were auth gates; don't inherit original failure
          : combinedStatus.state;
  const hasStatuses = combinedStatus.statuses.length > 0;

  // Collect failing status names from combined status API
  // Note: Combined statuses don't have conclusion data (only check runs do),
  // so these rely on name-based classification in classifyFailingChecks.
  for (const s of realStatuses) {
    if (s.state === 'failure' || s.state === 'error') {
      failingCheckNames.push(s.context);
    }
  }

  return { effectiveCombinedState, hasStatuses };
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
  const { effectiveCombinedState, hasStatuses } = combinedAnalysis;

  // Safety net: If we have ANY failing checks, report as failing
  if (hasFailingChecks || effectiveCombinedState === 'failure' || effectiveCombinedState === 'error') {
    return { status: 'failing', failingCheckNames, failingCheckConclusions };
  }

  if (hasPendingChecks || effectiveCombinedState === 'pending') {
    return { status: 'pending', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
    return { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  // No checks found at all - this is common for repos without CI
  if (!hasStatuses && checkRunCount === 0) {
    return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
}

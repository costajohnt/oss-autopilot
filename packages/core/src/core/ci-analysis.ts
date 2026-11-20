/**
 * CI Analysis - Classification and analysis of CI check runs and combined statuses.
 * Extracted from PRMonitor to isolate CI-related logic (#263).
 */

import type { Octokit } from '@octokit/rest';
import { CIFailureCategory, ClassifiedCheck, CIStatusResult, CIStatus, CIStatusCategorization } from './types.js';
import { getHttpStatusCode, errorMessage, isRateLimitOrAuthError } from './errors.js';
import { debug, warn } from './logger.js';
import { paginateAll } from './pagination.js';

/** Return a fresh unknown CI status (avoids shared mutable state between callers). */
function unknownCIStatus(): CIStatusResult {
  return { status: 'unknown', failingCheckNames: [], failingCheckConclusions: new Map() };
}

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
  // Tightened from plain `\binternal\b` (#1057 M34). Still catches the
  // known "Facebook Internal", "Meta Internal", and "Internal - <thing>"
  // fork-limitation checks (#675), but the negative lookahead prevents
  // misclassifying legitimate test checks like "Internal API tests" or
  // "Internal Integration Tests".
  /\binternal\b(?!\s+(?:api|test|integration|smoke|unit|e2e|regression|functional))/i,
];

/**
 * Known CI check name patterns that indicate authorization gates (#81).
 * These require maintainer approval and are not real failures.
 * Label/triage gates (e.g. "check PR labels", "Check PR type labels",
 * "needs-triage") are included: only maintainers can apply the labels that
 * satisfy them, so the contributor has nothing to fix.
 */
const AUTH_GATE_PATTERNS: RegExp[] = [
  /authoriz/i,
  /approval/i,
  /\bcla\b/i,
  /license\/cla/i,
  // Anchored to gate wording so real checks like "label-studio / build" or
  // "e2e-label-tests" stay actionable.
  /\b(?:pr|type|require[sd]?|check|missing)[\s-]+(?:\w+[\s-]+)?labels?\b/i,
  /\blabeler\b/i,
  /\btriage\b/i,
];

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
  /\breadthedocs\b/i,
];

/**
 * Classify a failing CI check as actionable, fork_limitation, auth_gate, or infrastructure (#81, #145, #743).
 * Default is 'actionable' — only known patterns get reclassified.
 * Conclusion-based classification (cancelled, timed_out, action_required) takes precedence
 * over name-based pattern matching.
 */
export function classifyCICheck(name: string, description?: string, conclusion?: string): CIFailureCategory {
  // Infrastructure: cancelled or timed_out jobs are transient failures (#145)
  if (conclusion === 'cancelled' || conclusion === 'timed_out') return 'infrastructure';

  // Auth gate: action_required means the workflow needs external approval (e.g., fork PR or first-time contributor)
  if (conclusion === 'action_required') return 'auth_gate';

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
 * Classify all failing checks and return a ClassifiedCheck array (#81, #145, #743).
 * Accepts optional conclusion data to detect infrastructure failures and auth gates.
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
 * Map an aggregate `ciStatus + failingCheckNames + classifiedChecks` triple
 * into one of five mutually exclusive overall states (#1272). The 5-row
 * truth table previously lived as prose in `agents/pr-health-checker.md`;
 * extracting it lets that agent (and any future consumer — dashboard,
 * MCP, sibling agents that adopt the field) read a single typed value
 * instead of re-deriving from `ciStatus + failingCheckNames + classifiedChecks`.
 *
 * Decision order (each branch is exclusive):
 *   1. `passing`                      → `all_passing`
 *   2. `pending`                      → `blocked` (awaiting trigger / completion)
 *   3. `failing` + actionable         → `failing` (real test/lint/build issue)
 *   4. `failing` + only infrastructure → `blocked` (cancelled/timed-out runner — needs rerun)
 *   5. `failing` + only fork/auth     → `fork_limitation` (informational)
 *   6. `failing` + zero classified    → `failing` w/ "details unavailable" summary
 *   7. `unknown`                      → `not_running`
 *
 * Why infrastructure routes to `blocked` and not `fork_limitation`:
 * a cancelled or timed-out runner is genuinely worth re-running; calling
 * it "informational" would tell the agent to ignore something the user
 * can fix with a rerun-request.
 *
 * The `summary` is short (≤180 char even for 10+ failing checks) and
 * suitable for inline display. `action` is a hint, not enforcement —
 * agents may still escalate based on other PR context.
 */
export function categorizeCIStatus(input: {
  ciStatus: CIStatus;
  failingCheckNames: string[];
  classifiedChecks: ClassifiedCheck[];
}): CIStatusCategorization {
  const { ciStatus, failingCheckNames, classifiedChecks } = input;

  if (ciStatus === 'passing') {
    return { category: 'all_passing', summary: 'All checks passing', action: 'none' };
  }

  if (ciStatus === 'pending') {
    // `mergeStatuses` currently sets `failingCheckNames: []` on pending,
    // so the count branch is defensive — kept so a future caller that
    // forwards pending names doesn't silently drop them.
    const count = failingCheckNames.length;
    const summary = count > 0 ? `${count} pending check(s); CI run incomplete` : 'CI checks pending';
    return { category: 'blocked', summary, action: 'request_rerun' };
  }

  if (ciStatus === 'failing') {
    const actionable = classifiedChecks.filter((c) => c.category === 'actionable');
    if (actionable.length > 0) {
      const preview = actionable
        .slice(0, 3)
        .map((c) => c.name)
        .join(', ');
      const more = actionable.length > 3 ? ` (+${actionable.length - 3} more)` : '';
      return {
        category: 'failing',
        summary: `${actionable.length} actionable failure(s): ${preview}${more}`,
        action: 'investigate',
      };
    }

    // No actionable failures. Distinguish three sub-cases:
    // (a) failing with zero classified checks: status came from the
    //     legacy combined-status endpoint without per-check detail. Be
    //     honest about the missing detail rather than asserting "fork
    //     limitations" the caller can't verify.
    if (classifiedChecks.length === 0) {
      return {
        category: 'failing',
        summary: 'CI reported failure but no check details available',
        action: 'investigate',
      };
    }

    // (b) at least one infrastructure failure (cancelled / timed-out /
    //     dependency-install). Re-running often fixes the issue, so
    //     surface as `blocked` with `request_rerun` rather than
    //     mislabeling as "fork limits / auth gates."
    const hasInfrastructure = classifiedChecks.some((c) => c.category === 'infrastructure');
    if (hasInfrastructure) {
      const total = classifiedChecks.length;
      return {
        category: 'blocked',
        summary: `${total} non-actionable failure(s) including infrastructure issues; rerun may resolve`,
        action: 'request_rerun',
      };
    }

    // (c) only fork-limitation / auth-gate failures — purely informational.
    const total = classifiedChecks.length;
    return {
      category: 'fork_limitation',
      summary: `${total} non-actionable failure(s) (fork limits / auth gates)`,
      action: 'informational',
    };
  }

  // ciStatus === 'unknown' — no checks reported, or status couldn't be
  // determined. Treat both as not_running so callers don't have to
  // distinguish the rare indeterminate case from the common "no CI
  // configured" case.
  return { category: 'not_running', summary: 'No CI checks reported', action: 'check_workflows' };
}

/**
 * Check-run conclusions that count as failing. `startup_failure` is a workflow
 * that never started (an invalid workflow file, for one): no job ran, so
 * nothing passed (#1918).
 */
const FAILING_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

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
    if (check.conclusion !== null && FAILING_CONCLUSIONS.has(check.conclusion)) {
      hasFailingChecks = true;
      failingCheckNames.push(check.name);
      failingCheckConclusions.set(check.name, check.conclusion);
    } else if (check.conclusion === null && check.status === 'waiting') {
      // `waiting` is an environment protection rule holding the job for a
      // deployment approval. Like an action_required run, only a maintainer
      // can clear it, so it is an auth gate: not passing, but not pending
      // either, which would turn into a stuck-CI rerun nudge the contributor
      // cannot act on. Recorded as action_required so classifyCICheck files
      // it under auth_gate.
      hasFailingChecks = true;
      failingCheckNames.push(check.name);
      failingCheckConclusions.set(check.name, 'action_required');
    } else if ((check.conclusion === null && check.status !== 'completed') || check.conclusion === 'stale') {
      // Any other run without a conclusion that has not completed is
      // pending: in_progress and queued, but also pending (concurrency
      // group) and requested. `stale` is a run GitHub gave up on before it
      // finished, so it never reached a verdict either.
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

  // No checks found at all — common for repos without CI. This has to come
  // before the passing branch: analyzeCombinedStatus reports `success` for an
  // empty status list, which would otherwise read a PR nothing ran on as
  // passing (#1918).
  if (!hasStatuses && checkRunCount === 0) {
    return unknownCIStatus();
  }

  if (hasSuccessfulChecks || effectiveCombinedState === 'success') {
    return { status: 'passing', failingCheckNames: [], failingCheckConclusions: new Map() };
  }

  return unknownCIStatus();
}

/** Minimal check-run shape consumed by {@link computeCIStatus} — shared by the
 *  REST (`checks.listForRef`) and GraphQL (`statusCheckRollup`) enrichment paths. */
export interface RawCheckRun {
  name: string;
  conclusion: string | null;
  status: string;
  /** ISO timestamp used to pick the most recent run when a name repeats. */
  started_at?: string | null;
  /** Id of the Actions workflow that produced the run (REST `workflow_id`,
   *  GraphQL `Workflow.databaseId`). Two runs are the same check only when both
   *  this and `name` match; absent for non-Actions check runs, which fall back
   *  to name alone (#1917). */
  workflowId?: number | null;
}

/** Minimal combined-status shape consumed by {@link computeCIStatus} — mirrors
 *  `repos.getCombinedStatusForRef` and GraphQL `commit.status`. */
export interface RawCombinedStatus {
  state: string;
  statuses: Array<{ state: string; context: string; description: string | null }>;
}

/**
 * Compute a {@link CIStatusResult} from raw check runs and combined-status data.
 *
 * Extracted so the REST path ({@link getCIStatus}) and the batched GraphQL
 * enrichment path (`pr-graphql.ts`) share identical status derivation — the
 * only difference between the two is where the raw check-run / combined-status
 * data comes from, guaranteeing CI-status parity by construction.
 *
 * Deduplicates check runs by workflow id + job name (keeping the most recent
 * run per pair), then merges the check-run and combined-status analyses.
 */
export function computeCIStatus(checkRuns: RawCheckRun[], combinedStatus: RawCombinedStatus): CIStatusResult {
  // Deduplicate check runs, keeping only the most recent run per workflow + name.
  // GitHub returns all historical runs (including re-runs), so without deduplication
  // a superseded failure will incorrectly flag the PR as failing even after a re-run passes.
  // The workflow is part of the key because two workflows can each have a `build`
  // job: keyed on the bare name, a later pass in one hides a failure in the other (#1917).
  const latestCheckRunsByName = new Map<string, RawCheckRun>();
  for (const check of checkRuns) {
    const key = `${check.workflowId ?? ''}\n${check.name}`;
    const existing = latestCheckRunsByName.get(key);
    if (!existing || new Date(check.started_at ?? 0) > new Date(existing.started_at ?? 0)) {
      latestCheckRunsByName.set(key, check);
    }
  }
  const deduped = [...latestCheckRunsByName.values()];

  const checkRunAnalysis = analyzeCheckRuns(deduped);
  const combinedAnalysis = analyzeCombinedStatus(combinedStatus);

  return mergeStatuses(checkRunAnalysis, combinedAnalysis, deduped.length);
}

/**
 * Map each check suite on a commit to the id of the workflow that ran it.
 *
 * A REST check run names its check suite but not its workflow, and a re-triggered
 * workflow gets a new suite, so the suite id alone cannot tell "re-run of the same
 * job" from "same-named job in another workflow" (#1917). The trigger event is
 * deliberately not part of the identity: a `push` and a `pull_request` run of one
 * workflow collapse to the latest, so a run cancelled by a shared concurrency
 * group does not read as a failure. If the lookup fails the map is empty and
 * dedupe degrades to name alone rather than losing the CI status.
 */
async function fetchWorkflowBySuite(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<Map<number | undefined, number>> {
  const fetchPage = async (page: number) => {
    const res = await octokit.actions.listWorkflowRunsForRepo({ owner, repo, page, head_sha: sha, per_page: 100 });
    return { data: res.data.workflow_runs };
  };
  const workflowBySuite = new Map<number | undefined, number>();
  let runs: Awaited<ReturnType<typeof fetchPage>>['data'];
  try {
    runs = await paginateAll(fetchPage);
  } catch (err) {
    if (isRateLimitOrAuthError(err)) throw err;
    const message = `Workflow runs unavailable for ${owner}/${repo}@${sha.slice(0, 7)}; deduping check runs by job name only: ${errorMessage(err)}`;
    // 404 is expected where Actions is not in use; anything else is worth surfacing.
    const log = getHttpStatusCode(err) === 404 ? debug : warn;
    log('pr-monitor', message);
    return workflowBySuite;
  }
  for (const run of runs) {
    workflowBySuite.set(run.check_suite_id, run.workflow_id);
  }
  return workflowBySuite;
}

/**
 * Get CI status for a commit SHA by querying both the combined status API and check runs API.
 * Returns the merged status and names of any failing checks for diagnostics.
 */
export async function getCIStatus(octokit: Octokit, owner: string, repo: string, sha: string): Promise<CIStatusResult> {
  if (!sha) return unknownCIStatus();

  try {
    // Fetch combined status, check runs and workflow runs in parallel
    const [statusResponse, checkRuns, workflowBySuite] = await Promise.all([
      // per_page 100: the default page holds 30 statuses, and analyzeCombinedStatus
      // only sees the page it is given.
      octokit.repos.getCombinedStatusForRef({ owner, repo, ref: sha, per_page: 100 }),
      // 404 is expected for repos without check runs configured; log other errors for debugging
      // Paginated: the default page is 30 check runs, and a failing check on a
      // later page would otherwise read as passing.
      paginateAll((page) =>
        octokit.checks
          .listForRef({ owner, repo, ref: sha, per_page: 100, page })
          .then((res) => ({ data: res.data.check_runs })),
      ).catch((err: unknown) => {
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
        // null, not [], for a failed fetch: the caller must not read "could not
        // fetch" as "no check runs" (#1918).
        return status === 404 ? [] : null;
      }),
      fetchWorkflowBySuite(octokit, owner, repo, sha),
    ]);

    const combinedStatus = statusResponse.data;
    const allCheckRuns = (checkRuns ?? []).map((run) => ({
      ...run,
      workflowId: workflowBySuite.get(run.check_suite?.id),
    }));

    const result = computeCIStatus(allCheckRuns, combinedStatus);
    // The check runs could not be read (already logged above), so a clean
    // combined status proves nothing about them. A failing or pending result
    // stands: no check run could have turned it into a pass (#1918).
    return checkRuns === null && result.status === 'passing' ? unknownCIStatus() : result;
  } catch (error) {
    const statusCode = getHttpStatusCode(error);

    if (statusCode === 401 || statusCode === 403 || statusCode === 429) {
      throw error;
    }
    if (statusCode === 404) {
      // Repo might not have CI configured, this is normal
      debug('pr-monitor', `CI check 404 for ${owner}/${repo} (no CI configured)`);
    } else {
      warn('pr-monitor', `Failed to check CI for ${owner}/${repo}@${sha.slice(0, 7)}: ${errorMessage(error)}`);
    }
    return unknownCIStatus();
  }
}
